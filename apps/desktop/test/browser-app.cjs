const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { writeFileSync, readFileSync, mkdirSync } = require('node:fs');
const { app } = require('electron');
const { createSpaceWindow } = require('../src/window.cjs');

const directory = process.env.SPACE_SMOKE_PROFILE;
const restart = process.env.SPACE_SMOKE_PHASE === 'restart';
app.setPath('userData', directory);
let actor = 'alice';
const server = createServer((req, res) => {
  if (req.url === '/v1/me') {
    if (!req.headers.cookie?.includes('signed-in=yes')) return res.writeHead(401).end();
    return res.setHeader('content-type', 'application/json').end(JSON.stringify({ id: actor }));
  }
  if (req.url === '/chat') {
    return res.setHeader('content-type', 'text/html').end('<nav class="chat-rail" style="width:68px"></nav><aside class="chat-sidebar" style="width:300px"></aside><textarea></textarea>');
  }
  res.setHeader('content-type', 'text/html').end('<title>Reports</title><label>Quarter<select id="quarter"><option>Q1</option><option>Q2</option></select></label><p>Quarterly revenue</p>');
});
function waitFor(contents, selector, text) {
  return contents.executeJavaScript(`new Promise((resolve, reject) => {
    const check = () => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (node?.textContent.startsWith('Codex sign-in') || node?.textContent.startsWith('Codex is unavailable')) {
        observer.disconnect(); clearTimeout(timer); reject(new Error(node.textContent)); return;
      }
      if (node && node.textContent.includes(${JSON.stringify(text)}) && !node.hidden) { observer.disconnect(); clearTimeout(timer); resolve(); }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes:true, childList:true, subtree:true, characterData:true });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Browser UI timed out: ' + document.body.innerText)); }, 65000);
    check();
  })`);
}
app.whenReady().then(async () => {
  const portFile = join(directory, 'port');
  server.listen(restart ? Number(readFileSync(portFile, 'utf8')) : 0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  writeFileSync(portFile, String(port));
  const base = 'http://127.0.0.1:' + port;
  const win = createSpaceWindow(base + '/chat', { show: false });
  await once(win.webContents, 'did-finish-load');
  await win.webContents.session.cookies.set({ url: base, name: 'signed-in', value: 'yes' });
  const created = once(app, 'web-contents-created');
  await win.webContents.executeJavaScript('spaceDesktop.openWorkspacePanel()');
  const [, bar] = await created;
  await once(bar, 'did-finish-load');
  const send = (action, arg) => bar.executeJavaScript('browserBar.command(' + JSON.stringify(action) + ',' + (JSON.stringify(arg) || 'null') + ')');
  const panel = win.contentView.children.find(view => view.children.some(child => child.webContents === bar));
  const guest = () => panel.children.at(-1).webContents;
  async function go() {
    await waitFor(bar, '#start:not([hidden]) #address', '');
    assert.ok(await bar.executeJavaScript("document.activeElement.id === 'address'"));
    const loaded = once(guest(), 'did-finish-load', { signal: AbortSignal.timeout(7000) });
    await bar.executeJavaScript(`document.querySelector('#address').value = ${JSON.stringify(base + '/report')}; document.querySelector('#visit').click()`);
    await loaded;
    await waitFor(bar, '#address-slot #address', '');
  }
  await waitFor(bar, '#workspace-start:not([hidden])', 'Open a tool');
  assert.equal(await bar.executeJavaScript("document.querySelectorAll('#tabs .tab').length"), 0);
  await bar.executeJavaScript("document.querySelector('#new').click()");
  for (const theme of ['light', 'dark']) {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await waitFor(bar, `html[data-theme="${theme}"] #start:not([hidden])`, 'Open a website');
    assert.equal(await bar.executeJavaScript('getComputedStyle(document.body).backgroundColor'),
      theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(26, 29, 33)');
  }
  assert.ok(await bar.executeJavaScript("document.querySelector('.space-mark').naturalWidth > 0"));
  assert.ok(await bar.executeJavaScript("document.fonts.load('13px Lato').then(faces => faces.length > 0)"));
  // An Office tab shares the workspace login. Ordinary browser tabs keep their own cookie jar.
  const assetId = '282b6a70-ea37-45c3-92e6-cf889470ac99';
  await win.webContents.executeJavaScript(`spaceDesktop.onOfficePicker(() => spaceDesktop.openOffice('library','${assetId}')); true`);
  await bar.executeJavaScript("document.querySelector('#add-tool').click()");
  await waitFor(bar, '#tool-slot #tools:not([hidden])', 'Office editor');
  await bar.executeJavaScript("document.querySelector('#office').click()");
  await waitFor(bar, '#tabs .current button', 'Reports');
  const library = guest();
  assert.equal(library.getURL(), base + '/office/library/' + assetId);
  assert.equal(await library.executeJavaScript("document.cookie.includes('signed-in=yes')"), true);
  assert.equal(await library.executeJavaScript("typeof spaceDesktop"), 'undefined');
  assert.equal(await library.executeJavaScript(`spaceOffice.openFile('${assetId}')`), true);
  const file = guest();
  await waitFor(file, 'p', 'Quarterly revenue');
  assert.equal(file.getURL(), base + '/office/file/' + assetId);
  await send('go', base + '/report');
  assert.equal(file.getURL(), base + '/office/file/' + assetId);
  assert.equal(await win.webContents.executeJavaScript(`spaceDesktop.openOffice('file','${assetId}')`), true);
  assert.equal(guest().id, file.id);
  const tabIds = panel.children.map(view => view.webContents.id);
  const hidden = once(win.webContents.ipc, 'space-browser-hide', { signal: AbortSignal.timeout(5000) });
  await win.webContents.executeJavaScript('spaceDesktop.openWorkspacePanel(); spaceDesktop.hideWorkspacePanel()');
  await hidden;
  assert.equal(panel.getVisible(), false);
  await win.spaceBrowser.showPanel();
  assert.equal(panel.getVisible(), true);
  assert.deepEqual(panel.children.map(view => view.webContents.id), tabIds);
  assert.equal(panel.children.find(view => view.webContents === file).getVisible(), true);
  await file.executeJavaScript("spaceOffice.onClose(done => { window.confirmClose = done; }); true");
  await send('close', file.id);
  assert.ok(!file.isDestroyed());
  const removed = once(file, 'destroyed');
  await file.executeJavaScript('window.confirmClose(); true');
  await removed;
  await send('close', library.id);
  await go();
  const first = guest();
  const width = win.getContentSize()[0];
  const chat = win.contentView.children.find(view => view.webContents === win.webContents);
  assert.ok(chat, 'chat remains mounted beside the browser');
  assert.equal(chat.getBounds().width, panel.getBounds().x);
  const gutter = await bar.executeJavaScript('document.getElementById("divider").offsetWidth');
  const chatWidth = await win.webContents.executeJavaScript('innerWidth');
  assert.ok(chatWidth > 720, 'opening the browser keeps desktop navigation visible at the default window width');
  assert.ok(Math.abs((chatWidth - 68 - 300) - (panel.getBounds().width - gutter)) <= 1,
    'the conversation and browser split the space after navigation');
  assert.equal(await first.executeJavaScript('innerWidth'), panel.getBounds().width - gutter);
  assert.ok(await bar.executeJavaScript('document.querySelector("header").offsetHeight <= 65'));
  const height = win.getContentSize()[1];
  for (const [windowWidth, expectedWorkspace] of [[1070, 721], [800, 472], [width, chatWidth]]) {
    win.setContentSize(windowWidth, height);
    // Hidden smoke windows can defer the native resize event on macOS.
    win.emit('resize');
    assert.equal(chat.getBounds().width, expectedWorkspace);
    assert.ok(panel.getBounds().width - gutter >= 320);
  }
  const expectedLeft = chat.getBounds().width + 80;
  bar.debugger.attach();
  const pointer = (type, x, buttons) => bar.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, x, y: 160, button: 'left', buttons, clickCount: 1,
  });
  try {
    await pointer('mousePressed', 3, 1);
    await pointer('mouseMoved', 83, 1);
    await bar.executeJavaScript(`new Promise((resolve, reject) => {
      const separator = document.querySelector('#divider');
      const observer = new MutationObserver(check);
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Divider drag did not resize chat')); }, 4000);
      function check() {
        if (Number(separator.getAttribute('aria-valuenow')) === ${expectedLeft}) {
          clearTimeout(timeout); observer.disconnect(); resolve();
        }
      }
      observer.observe(separator, { attributes: true }); check();
    })`);
    await pointer('mouseReleased', 3, 0);
  } finally { bar.debugger.detach(); }
  assert.equal(chat.getBounds().width, expectedLeft);
  await send('layout');
  assert.equal(panel.getBounds().width, width);
  assert.equal(chat.getVisible(), false);
  win.spaceBrowser.togglePanel();
  assert.equal(panel.getVisible(), false, 'cycling from full view hides tabs');
  await win.spaceBrowser.togglePanel();
  assert.equal(chat.getVisible(), true);
  assert.equal(chat.getBounds().width, expectedLeft);
  assert.equal(panel.getBounds().x, chat.getBounds().width);
  await win.spaceBrowser.togglePanel();
  assert.equal(chat.getVisible(), false, 'cycling from split view expands tabs');
  await send('space');
  assert.equal(chat.getBounds().width, width);
  await win.spaceBrowser.open();
  assert.equal(chat.getBounds().width, expectedLeft, 'reopening restores the dragged split');
  assert.equal(first.getURL(), base + '/report');
  assert.equal(await first.executeJavaScript('typeof spaceDesktop + ":" + typeof browserBar + ":" + typeof require'), 'undefined:undefined:undefined');
  assert.equal(await first.executeJavaScript('document.cookie.includes("signed-in")'), false);
  if (restart) {
    assert.equal(await first.executeJavaScript('localStorage.quarter'), 'Q2');
    assert.equal(await first.executeJavaScript('document.cookie.includes("report-login=yes")'), true);
    actor = 'bob';
    const closed = once(first, 'destroyed');
    await win.webContents.executeJavaScript('spaceDesktop.browserAccountChanged("bob")');
    await closed;
    await win.spaceBrowser.open(true);
    const second = guest();
    await second.loadURL(base + '/report');
    assert.equal(await second.executeJavaScript('localStorage.quarter ?? null'), null);
    assert.equal(await second.executeJavaScript('document.cookie.includes("report-login=yes")'), false);
    assert.ok(first.isDestroyed());
  } else {
    await first.executeJavaScript('localStorage.quarter = "Q2"; document.cookie = "report-login=yes;max-age=3600"');
    const popupCreated = once(app, 'web-contents-created', { signal: AbortSignal.timeout(5000) });
    await first.executeJavaScript('void window.open("/report", "_blank")', true);
    const [, popup] = await popupCreated;
    assert.equal(guest().id, popup.id, 'the pre-created popup must be adopted as the selected tab');
    if (popup.isLoading() || !popup.getURL()) await once(popup, 'did-finish-load', { signal: AbortSignal.timeout(5000) });
    assert.equal(await popup.executeJavaScript('localStorage.quarter'), 'Q2');
    assert.equal(await popup.executeJavaScript('typeof spaceDesktop + ":" + typeof browserBar + ":" + typeof require'), 'undefined:undefined:undefined');
    assert.equal(popup.getLastWebPreferences().sandbox, true);
    assert.equal(guest().id, popup.id);
    await send('new'); await go();
    assert.equal(await guest().executeJavaScript('localStorage.quarter'), 'Q2');
    await send('switch', first.id);
    if (process.env.SPACE_BROWSER_TEST_REAL_AGENT !== '1') {
      const bin = join(directory, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\n' +
        `let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const { page, history } = JSON.parse(input);
  const action = history.length ? { type: 'done', message: 'Finished Q2' } : { type: 'select', id: page.controls[0].id, option: 1 };
  console.log(JSON.stringify(action));
});`, { mode: 0o700 });
      process.env.PATH = bin + ':' + process.env.PATH;
    }
    await send('agent', 'Select Q2 in Quarter. After selecting, finish with the exact message Finished Q2.');
    await send('resize', 520);
    assert.equal(chat.getBounds().width, 520);
    await waitFor(bar, '#notice', 'Finished Q2');
    assert.equal(await first.executeJavaScript('quarter.selectedIndex'), 1);
    await first.executeJavaScript('quarter.selectedIndex = 0');
    await bar.executeJavaScript("document.querySelector('#ask').click(); document.querySelector('#goal').value = 'Select Q2.'; document.querySelector('#task').requestSubmit()");
    await waitFor(bar, '#stop:not([hidden])', 'Take over');
    await bar.executeJavaScript("document.querySelector('#stop').click()");
    await waitFor(bar, '#notice', 'You have control');
    assert.equal(await first.executeJavaScript('quarter.selectedIndex'), 0);
    await send('agent', 'Select Q2.');
    await send('new');
    assert.equal(await bar.executeJavaScript('document.querySelector("#stop").hidden'), true);
    assert.equal(await first.executeJavaScript('quarter.selectedIndex'), 0);
    await send('switch', first.id);
    await first.executeJavaScript('document.body.insertAdjacentHTML("beforeend", "<input type=password>")');
    await send('agent', 'Inspect this page');
    await waitFor(bar, '#notice', 'needs your attention');
    await send('space'); await win.spaceBrowser.open();
    assert.equal(await first.executeJavaScript('localStorage.quarter'), 'Q2');
    await first.session.cookies.flushStore(); first.session.flushStorageData();
  }
  win.destroy();
  console.log('PASS (' + process.env.SPACE_SMOKE_PHASE + '): personal browser, storage isolation and tab control');
  server.close(); app.exit(0);
}).catch(error => { console.error(error); server.close(); app.exit(1); });
