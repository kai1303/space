const { app, dialog, Menu } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spaceUrl } = require('./policy.cjs');
const { createSpaceWindow } = require('./window.cjs');

app.setName('Space');
let win;
let url;
function openWindow() {
  if (!win || win.isDestroyed()) win = createSpaceWindow(url);
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (url) openWindow(); });
  app.on('activate', () => { if (url) openWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.whenReady().then(() => {
    let config = require('../desktop.config.json');
    try {
      config = JSON.parse(readFileSync(join(app.getPath('userData'), 'desktop.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    url = spaceUrl(process.env.SPACE_DESKTOP_URL || config.url);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'File', submenu: [{ label: 'Open Space', accelerator: 'CmdOrCtrl+1', click: openWindow }, { role: 'close' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
    openWindow();
  }).catch(error => {
    dialog.showErrorBox('Space could not start', error.message);
    app.quit();
  });
}
