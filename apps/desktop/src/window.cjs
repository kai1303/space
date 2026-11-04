const { BrowserWindow, dialog, shell } = require('electron');
const { navigationAction, spaceUrl, isAssetDownload } = require('./policy.cjs');

function createSpaceWindow(configuredUrl, { show = true } = {}) {
  const url = spaceUrl(configuredUrl);
  const win = new BrowserWindow({
    title: 'Space', width: 1360, height: 900, minWidth: 800, minHeight: 600,
    show: false, backgroundColor: '#19171d',
    webPreferences: {
      partition: 'persist:space',
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false,
    },
  });
  // Permissions are opt-in product work; the initial shell needs none.
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
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
    if (action === 'internal') void win.loadURL(target).catch(() => {});
    return { action: 'deny' };
  });
  win.on('ready-to-show', () => { if (show) win.show(); });
  win.webContents.on('did-fail-load', async (_event, code, _description, _target, isMainFrame) => {
    if (!isMainFrame || code === -3 || win.isDestroyed() || !show) return;
    win.show();
    const { response } = await dialog.showMessageBox(win, {
      type: 'error', message: 'Cannot connect to Space',
      detail: `Check that your Space web server is running at ${new URL(url).origin}. The desktop app does not start the server.`,
      buttons: ['Retry', 'Close'], defaultId: 0, cancelId: 1,
    });
    if (win.isDestroyed()) return;
    if (response === 0) void win.loadURL(url).catch(() => {});
    else win.close();
  });
  void win.loadURL(url).catch(() => {}); // did-fail-load provides the recovery UI.
  return win;
}

module.exports = { createSpaceWindow };
