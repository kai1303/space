const { BaseWindow, WebContentsView, dialog, shell } = require('electron');
const { createBrowser } = require('./browser/browser.cjs');
const { join } = require('node:path');
const { navigationAction, spaceUrl, isAssetDownload, mediaPermissionAllowed } = require('./policy.cjs');

function createSpaceWindow(configuredUrl, { show = true, pair } = {}) {
  const url = spaceUrl(configuredUrl);
  const win = new BaseWindow({
    title: 'Space', width: 1360, height: 900, minWidth: 800, minHeight: 600,
    icon: join(__dirname, '../assets/space-icon.png'),
    show: false, backgroundColor: '#19171d',
  });
  const workspace = new WebContentsView({
    webPreferences: {
      partition: 'persist:space',
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false,
    },
  });
  win.contentView.addChildView(workspace);
  win.webContents = workspace.webContents;
  win.spaceBrowser = createBrowser(win, url, workspace);
  win.once('closed', () => { if (!workspace.webContents.isDestroyed()) workspace.webContents.close(); });
  win.webContents.on('page-title-updated', (_event, title) => { if (!win.isDestroyed()) win.setTitle(title || 'Space'); });
  win.webContents.ipc.on('space-browser-open', event => {
    if (event.senderFrame === win.webContents.mainFrame && navigationAction(win.webContents.getURL(), url) === 'internal') void win.spaceBrowser.showPanel();
  });
  win.webContents.ipc.on('space-browser-hide', event => {
    if (event.senderFrame === win.webContents.mainFrame && navigationAction(win.webContents.getURL(), url) === 'internal') win.spaceBrowser.hidePanel();
  });
  win.webContents.ipc.handle('space-office-open', (event, kind, id) => {
    if (event.senderFrame !== win.webContents.mainFrame || event.senderFrame.origin !== new URL(url).origin) return false;
    return win.spaceBrowser.openOffice(kind, id);
  });
  win.webContents.ipc.on('space-browser-account', (event, actor) => {
    if (event.senderFrame === win.webContents.mainFrame && navigationAction(win.webContents.getURL(), url) === 'internal') win.spaceBrowser.accountChanged(actor);
  });
  if (pair) {
    const contents = win.webContents;
    let pending = false;
    contents.ipc.handle('pair-local-agent', async (event, provider, code) => {
      const trusted = () => !win.isDestroyed() && event.senderFrame === contents.mainFrame
        && navigationAction(contents.getURL(), url) === 'internal';
      if (pending || !trusted()) throw new Error('Desktop pairing is unavailable.');
      pending = true;
      try {
        require('./runners.cjs').validatePair(provider, code);
        const { response } = await dialog.showMessageBox(win, {
          type: 'question', message: `Connect local ${provider} to Space?`,
          detail: `${new URL(url).origin} will use this agent for approved chats while Space Desktop is open.`,
          buttons: ['Connect', 'Cancel'], defaultId: 0, cancelId: 1,
        });
        if (response !== 0 || !trusted()) throw new Error('Pairing cancelled.');
        await pair(provider, code);
      } finally { pending = false; }
    });
  }
  const approvedMedia = new Set();
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = details.requestingUrl;
    const types = details.mediaTypes || [];
    if (contents !== win.webContents || !mediaPermissionAllowed(permission, origin, url, types)
      || navigationAction(contents.getURL(), url) !== 'internal') { callback(false); return; }
    if (types.length && types.every(type => approvedMedia.has(type))) { callback(true); return; }
    void dialog.showMessageBox(win, {
      type: 'question', message: 'Allow Space to use the requested media devices?',
      detail: `${new URL(url).origin} is requesting ${types.join(' and ') || 'media'} access. Space uses these devices for calls and clips, and the microphone for dictation.`,
      buttons: ['Allow', 'Not now'], defaultId: 1, cancelId: 1,
    }).then(({ response }) => {
      const allowed = response === 0 && !win.isDestroyed() && navigationAction(contents.getURL(), url) === 'internal';
      if (allowed) types.forEach(type => approvedMedia.add(type));
      callback(allowed);
    }).catch(() => callback(false));
  });
  win.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) =>
    contents === win.webContents && mediaPermissionAllowed(permission, origin, url)
      && approvedMedia.has(details.mediaType));
  win.webContents.on('will-attach-webview', event => event.preventDefault());

  const openExternal = value => {
    void shell.openExternal(value).catch(() => {
      if (!win.isDestroyed()) void dialog.showMessageBox(win, { type: 'error', message: 'Could not open this link in your browser.' });
    });
  };
  win.webContents.on('will-navigate', (event, target) => {
    // Downloads retain this session's cookies and can follow signed storage redirects
    // without navigating the trusted renderer to the storage origin.
    if (isAssetDownload(target, url)) {
      event.preventDefault();
      win.webContents.downloadURL(target);
      return;
    }
    const action = navigationAction(target, url);
    if (action !== 'internal') event.preventDefault();
    if (action === 'external') openExternal(target);
  });
  // Redirects must not silently move the trusted application to another origin.
  win.webContents.on('will-redirect', (event, target) => {
    if (navigationAction(target, url) !== 'internal') event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isAssetDownload(target, url)) {
      win.webContents.downloadURL(target);
      return { action: 'deny' };
    }
    const action = navigationAction(target, url);
    if (action === 'external') openExternal(target);
    if (action === 'internal') void win.webContents.loadURL(target).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.once('dom-ready', () => { if (show) { win.show(); win.webContents.focus(); } });
  win.webContents.on('did-fail-load', async (_event, code, _description, _target, isMainFrame) => {
    if (!isMainFrame || code === -3 || win.isDestroyed() || !show) return;
    win.show();
    const { response } = await dialog.showMessageBox(win, {
      type: 'error', message: 'Cannot connect to Space',
      detail: `Check that your Space web server is running at ${new URL(url).origin}. The desktop app does not start the server.`,
      buttons: ['Retry', 'Close'], defaultId: 0, cancelId: 1,
    });
    if (win.isDestroyed()) return;
    if (response === 0) void win.webContents.loadURL(url).catch(() => {});
    else win.close();
  });
  void win.webContents.loadURL(url).catch(() => {}); // did-fail-load provides the recovery UI.
  return win;
}

module.exports = { createSpaceWindow };
