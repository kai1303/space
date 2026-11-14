const { app, dialog, Menu, nativeTheme } = require('electron');
const { readFileSync, writeFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');
const { spaceUrl, desktopHandoff } = require('./policy.cjs');
const { createSpaceWindow } = require('./window.cjs');

const { createRunners } = require('./runners.cjs');
const { providerLogin } = require('./login.cjs');

app.setName('Space');
let runners, pendingLink, opening = false, quitting = false;
function configure(value) {
  url = spaceUrl(value);
  runners = createRunners({ origin: new URL(url).origin, userData: app.getPath('userData'),
    resources: app.isPackaged ? join(process.resourcesPath, 'runner') : join(__dirname, '../dist/runner'),
    webVault: async (request, signal) => {
      if (quitting || !win || win.isDestroyed()) return {status: 'unavailable'};
      return win.spaceBrowser.webVault(request, signal);
    },
    vaultTool: (context, signal) => win?.spaceBrowser.vaultTool(context, signal) ?? 'unavailable',
    login: providerLogin, notify: (provider, detail) => {
      if (!quitting) void dialog.showMessageBox({ type: 'error', message: `Local ${provider} needs attention`, detail });
    },
  });
  runners.restore();
}
async function handoff(target) {
  if (opening || quitting) return;
  opening = true;
  try {
    if (new URL(url).origin !== target.origin) {
      const { response } = await dialog.showMessageBox({ type: 'question', message: 'Switch Space Desktop to this server?',
        detail: `Open ${target.origin} and sign in there to connect an agent. Running agents on the current server will stop.`,
        buttons: ['Switch server', 'Cancel'], defaultId: 1, cancelId: 1 });
      if (response !== 0 || quitting) return;
      const file = join(app.getPath('userData'), 'desktop.json');
      writeFileSync(file + '.tmp', JSON.stringify({ url: target.origin }), { mode: 0o600 });
      renameSync(file + '.tmp', file);
      if (win && !win.isDestroyed()) win.destroy();
      await runners.stop();
      if (quitting) return;
      configure(target.origin);
    }
    if (!win || win.isDestroyed()) win = createSpaceWindow(target.href, { pair: runners.start });
    else { openWindow(); await win.webContents.loadURL(target.href); }
  } catch (error) { if (!quitting) dialog.showErrorBox('Cannot open Space Desktop', error.message); }
  finally { opening = false; }
}
let win;
let url;
function openWindow() {
  if (!win || win.isDestroyed()) win = createSpaceWindow(url, { pair: runners.start });
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('open-url', (event, value) => {
    event.preventDefault();
    const target = desktopHandoff(value);
    if (!target) return;
    if (runners) void handoff(target);
    else pendingLink = target;
  });
  app.on('before-quit', event => {
    if (!runners || quitting) return;
    event.preventDefault();
    quitting = true;
    void runners.stop().finally(() => app.quit());
  });
  app.on('second-instance', () => { if (url) openWindow(); });
  app.on('activate', () => { if (url) openWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.whenReady().then(() => {
    if (app.dock) {
      const updateDockIcon = () => {
        const icon = nativeTheme.shouldUseDarkColors ? 'space-icon-dark.png' : 'space-icon.png';
        app.dock.setIcon(join(__dirname, '../assets', icon));
      };
      updateDockIcon();
      nativeTheme.on('updated', updateDockIcon);
    }
    let config = require('../desktop.config.json');
    try {
      config = JSON.parse(readFileSync(join(app.getPath('userData'), 'desktop.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    configure(process.env.SPACE_DESKTOP_URL || config.url);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'File', submenu: [...(process.platform === 'darwin' ? [{ label: 'Open Personal Vault…', click: async () => {
        openWindow();
        if (win.webContents.isLoadingMainFrame()) await require('node:events').once(win.webContents, 'did-finish-load');
        if (!win || win.isDestroyed()) return;
        win.spaceBrowser.hide();
        if (new URL(win.webContents.getURL()).origin === new URL(url).origin)
          win.webContents.send('space-vault-page');
      } }] : []), { label: 'New Browser Tab', accelerator: 'CmdOrCtrl+T', click: () => {
        if (!win || win.isDestroyed()) openWindow();
        void win.spaceBrowser.open(true);
      } }, { label: 'Cycle Workspace Layout', accelerator: 'CmdOrCtrl+Shift+B', click: () => {
        if (!win || win.isDestroyed()) openWindow();
        void win.spaceBrowser.togglePanel();
      } }, { label: 'Open Space', accelerator: 'CmdOrCtrl+1', click: () => { openWindow(); win.spaceBrowser.hide(); } }, { role: 'close' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
    if (pendingLink) void handoff(pendingLink).finally(() => { if (!quitting) openWindow(); });
    else openWindow();
  }).catch(error => {
    dialog.showErrorBox('Space could not start', error.message);
    app.quit();
  });
}
