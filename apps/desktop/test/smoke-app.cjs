const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createSpaceWindow } = require('../src/window.cjs');

app.setPath('userData', process.env.SPACE_SMOKE_PROFILE);
// Keep the test process alive while destroying and recreating its only window.
app.on('window-all-closed', () => {});
const assetId = '00000000-0000-4000-8000-000000000001';
const storage = createServer((_request, response) => {
  response.setHeader('Content-Disposition', 'attachment; filename="desktop-qa.txt"');
  response.end('Desktop download fixture');
});
const server = createServer((request, response) => {
  if (request.url === `/v1/assets/${assetId}/download`) {
    if (!request.headers.cookie?.includes('space-smoke=persisted')) { response.writeHead(401).end(); return; }
    response.writeHead(302, { Location: `http://127.0.0.1:${storage.address().port}/file` }).end();
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>Space desktop smoke</title><a id="next" href="/next">Next</a><a id="download" href="/v1/assets/${assetId}/download">Download</a>`);
});

app.whenReady().then(async () => {
  storage.listen(0, '127.0.0.1');
  await once(storage, 'listening');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/chat`;
  let win = createSpaceWindow(url, { show: false });
  await once(win.webContents, 'did-finish-load');
  assert.equal(win.getTitle(), 'Space desktop smoke');
  const isolation = await win.webContents.executeJavaScript('({ require: typeof require, process: typeof process })');
  assert.deepEqual(isolation, { require: 'undefined', process: 'undefined' });
  const preferences = win.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);

  if (process.env.SPACE_SMOKE_PHASE === 'restart') {
    const restored = await win.webContents.session.cookies.get({ url, name: 'space-smoke' });
    assert.equal(restored[0]?.value, 'persisted', 'cookie survives a full Electron restart');
  }

  let loaded = once(win.webContents, 'did-finish-load');
  await win.webContents.executeJavaScript('document.getElementById("next").click()');
  await loaded;
  assert.equal(new URL(win.webContents.getURL()).pathname, '/next');
  assert.equal(await win.webContents.executeJavaScript('window.open("file:///etc/passwd") === null'), true);
  assert.equal(BrowserWindow.getAllWindows().length, 1);

  await win.webContents.session.cookies.set({ url, name: 'space-smoke', value: 'persisted', expirationDate: Date.now() / 1000 + 3600 });
  await win.webContents.session.cookies.flushStore();
  const savedFile = join(process.env.SPACE_SMOKE_PROFILE, 'desktop-qa.txt');
  const downloaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Authenticated redirected download never completed')), 4000);
    win.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(savedFile);
      item.once('done', (_event, state) => {
        clearTimeout(timeout);
        if (state === 'completed') resolve(); else reject(new Error(`Download ${state}`));
      });
    });
  });
  await win.webContents.executeJavaScript('document.getElementById("download").click()');
  await downloaded;
  assert.equal(readFileSync(savedFile, 'utf8'), 'Desktop download fixture');
  assert.equal(new URL(win.webContents.getURL()).pathname, '/next', 'downloads must not navigate away from chat');
  win.destroy();
  win = createSpaceWindow(url, { show: false });
  await once(win.webContents, 'did-finish-load');
  const cookies = await win.webContents.session.cookies.get({ url, name: 'space-smoke' });
  assert.equal(cookies[0]?.value, 'persisted');
  win.destroy();
  console.log(`PASS (${process.env.SPACE_SMOKE_PHASE}): renderer isolation, navigation, authenticated redirected download, persistent session`);
  server.close();
  storage.close();
  app.exit(0);
}).catch(error => {
  console.error(error);
  server.close();
  storage.close();
  app.exit(1);
});
