const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { writeFileSync, readFileSync, mkdirSync } = require('node:fs');
const { app, dialog } = require('electron');
const { createSpaceWindow } = require('../src/window.cjs');

const directory = process.env.SPACE_SMOKE_PROFILE;
const restart = process.env.SPACE_SMOKE_PHASE === 'restart';
app.setPath('userData', directory);
let actor = 'alice';
const vaultWorkspace = '282b6a70-ea37-45c3-92e6-cf889470ac99';
const vaultInstallation = '76d1bf53-88be-43a7-835c-abd20ffc8477';
let testVault = async () => ({ status: 'cancelled' });
let personalConnections = [], connectionChecks = 0;
const server = createServer((req, res) => {
  if (req.url?.startsWith('/v1/agent-sessions/')) {
    assert.equal(req.headers['x-expected-actor'], actor);
    return res.setHeader('content-type', 'application/json').end(JSON.stringify({
      session: { id: req.url.split('/').at(-1), owner_id: actor, workspace_id: vaultWorkspace, installation_id: vaultInstallation, agent_name: 'Kai Mac Codex' },
      context: { browser_url: 'https://linear.app/login' },
    }));
  }
  if (req.url === '/v1/me') {
    if (!req.headers.cookie?.includes('signed-in=yes')) return res.writeHead(401).end();
    return res.setHeader('content-type', 'application/json').end(JSON.stringify({ id: actor }));
  }
  if (req.url === '/v1/me/connections') {
    assert.equal(req.headers['x-expected-actor'], actor);
    assert.match(req.headers.cookie || '', /signed-in=yes/);
    connectionChecks++;
    return res.setHeader('content-type', 'application/json').end(JSON.stringify({ items: personalConnections }));
  }
  if (req.url?.endsWith('/office-session?mode=edit')) {
    return res.writeHead(403).end();
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
  const win = createSpaceWindow(base + '/chat', { show: false, keychain: (...args) => testVault(...args), vaultManager: (...args) => testVault(...args) });
  await once(win.webContents, 'did-finish-load');
  await win.webContents.session.cookies.set({ url: base, name: 'signed-in', value: 'yes' });
  if (process.platform === 'darwin') {
    const initialActor = actor;
    actor = vaultWorkspace;
    const signal = new AbortController().signal;
    testVault = async (_path, request) => {
      assert.deepEqual(request, {action: 'web-list', platform: base, origin: base, actor});
      return {status: 'listed', items: [{title:'Linear',kind:'token',site:'https://linear.app'}], more:false};
    };
    assert.deepEqual(await win.spaceBrowser.webVault({action:'list', actor:vaultInstallation},signal), {status:'unavailable'});
    assert.equal((await win.spaceBrowser.webVault({action:'list',actor},signal)).status, 'listed');
    await win.webContents.executeJavaScript("spaceDesktop.browserAccountChanged(null)");
    actor = initialActor;
    let managerCalls = 0;
    testVault = async (_path, request) => {
      managerCalls++;
      assert.deepEqual(request, { action: 'manager', platform: base, actor, origin: '', endpoint: undefined });
      return { status: 'closed' };
    };
    assert.equal(await win.webContents.executeJavaScript("spaceDesktop.openVault('someone-else')"), 'unavailable');
    assert.equal(await win.webContents.executeJavaScript("spaceDesktop.openVault('alice')"), 'closed');
    assert.equal(managerCalls, 1);
    const { promise: started, resolve: didOpen } = Promise.withResolvers();
    const windowCount = require('electron').BaseWindow.getAllWindows().length;
    testVault = (...args) => {
      const closed = require('../src/browser/vault.cjs').presentVault(...args);
      assert.equal(require('electron').BaseWindow.getAllWindows().length, windowCount);
      didOpen();
      return closed;
    };
    const opened = win.webContents.executeJavaScript("spaceDesktop.openVault('alice')");
    await started;
    assert.equal(await win.webContents.executeJavaScript("spaceDesktop.openVault('alice')"), 'busy');
    await win.webContents.executeJavaScript("spaceDesktop.browserAccountChanged(null)");
    assert.equal(await opened, 'closed');
    testVault = async () => ({ status: 'cancelled' });
  }
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
  const assetId = '282b6a70-ea37-45c3-92e6-cf889470ac99';
  async function click(id) {
    await bar.executeJavaScript('document.querySelector(' + JSON.stringify(id) + ').click()');
  }
  await waitFor(bar, '#workspace-start:not([hidden])', 'Manage plugins');
  await click('#manage');
  for (const id of ['browser', 'office']) {
    await waitFor(bar, '[data-plugin="' + id + '"]', restart ? 'Remove' : 'Install');
  }
  if (!restart) {
    await click('[data-plugin="office"]');
    await waitFor(bar, '[data-plugin="office"]', 'Remove');
    await click('[data-plugin="office"]');
    await waitFor(bar, '[data-plugin="office"]', 'Install');
    assert.ok(await bar.executeJavaScript('document.querySelector("#new").hidden && document.querySelector("#office").hidden'));
    await click('[data-plugin="browser"]');
    await waitFor(bar, '[data-plugin="browser"]', 'Remove');
    assert.ok(await bar.executeJavaScript('document.querySelector("#office").hidden'));
    const original = dialog.showMessageBox;
    try {
      dialog.showMessageBox = async (_win, options) => {
        assert.equal(options.message, 'Install Office editor?');
        assert.deepEqual(options.buttons, ['Install and open', 'Cancel']);
        return { response: 1 };
      };
      assert.equal(await win.spaceBrowser.openOffice('file', assetId), false);
      assert.equal(panel.children.length, 1);
    } finally { dialog.showMessageBox = original; }
  }
  await click('#plugins-done');
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
  await win.webContents.executeJavaScript(`spaceDesktop.onOfficePicker(() => spaceDesktop.openOffice('library','${assetId}')); true`);
  await bar.executeJavaScript("document.querySelector('#add-tool').click()");
  await waitFor(bar, '#tool-slot #tools:not([hidden])', 'Manage plugins');
  if (!restart) {
    await click('#manage');
    await click('[data-plugin="browser"]');
    await waitFor(bar, '#notice', 'Close all Web Browser tabs');
    await click('[data-plugin="office"]');
    await waitFor(bar, '[data-plugin="office"]', 'Remove');
    await click('#plugins-done');
  }
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
  await assert.rejects(file.executeJavaScript("spaceOffice.checkEditAccess('old.edit.0')"), /Editing access changed/);
  await assert.rejects(file.executeJavaScript("spaceOffice.ask('Rewrite', 'selected text', 'old.edit.0')"), /Editing access changed/);
  await assert.rejects(library.executeJavaScript("spaceOffice.ask('Rewrite', 'selected text', 'old.edit.0')"), /Office task unavailable/);
  await file.executeJavaScript("spaceOffice.onClose(done => { window.confirmClose = done; }); true");
  await send('close', file.id);
  assert.ok(!file.isDestroyed());
  const removed = once(file, 'destroyed');
  await file.executeJavaScript('window.confirmClose(); true');
  await removed;
  await send('close', library.id);
  await go();
  const first = guest();
  if (!restart) {
    const registrySearches = [];
    first.session.protocol.handle('https', request => {
      const url = new URL(request.url);
      if (url.pathname === '/login') return new Response('<form method="post"><input autocomplete="username"><input type="password"></form>', { headers: { 'content-type': 'text/html' } });
      if (url.hostname !== 'registry.modelcontextprotocol.io') return new Response('<title>Provider</title>', { headers: { 'content-type': 'text/html' } });
      const search = url.searchParams.get('search');
      registrySearches.push(search);
      assert.equal(request.headers.get('cookie'), null);
      return Response.json({ servers: search === 'com.postman/' ? [{
        server: { name: 'com.postman/postman-mcp-server', title: 'Postman MCP Server', remotes: [{ type: 'streamable-http', url: 'https://mcp.postman.com/mcp' }] },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
      }] : [] });
    });
    const suggestion = '#mcp-suggestion:not([hidden])';
    try {
      await first.loadURL('https://github.com.example.org/test');
      assert.equal(connectionChecks, 0);
      await first.loadURL('https://team.postman.com/private/project?token=secret');
      await waitFor(bar, suggestion, 'Postman MCP Server');
      await waitFor(bar, '#mcp-endpoint', 'https://mcp.postman.com/mcp');
      await first.loadURL('https://www.postman.com/other');
      assert.equal(registrySearches.filter(search => search === 'com.postman/').length, 1);
      await first.loadURL('https://github.com/owner/repo?private=yes');
      await waitFor(bar, suggestion, 'GitHub MCP');
      const checks = connectionChecks;
      await first.loadURL('https://github.com/owner/repo/pull/1');
      assert.equal(connectionChecks, checks);
      const setup = win.webContents.executeJavaScript(`new Promise(resolve => {
        const off = spaceDesktop.onBrowserMcpSetup(site => { off(); resolve(site); });
      })`);
      await click('#connect-mcp');
      assert.deepEqual(await setup, { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', actor: 'alice' });
      testVault = async (_resources, request) => {
        assert.equal(request.action, 'add-token');
        assert.equal(request.endpoint, 'https://api.githubcopilot.com/mcp/');
        assert.equal(request.actor, 'alice');
        return { status: 'saved' };
      };
      assert.equal(await win.webContents.executeJavaScript("spaceDesktop.saveBrowserVaultToken('https://invalid.example/mcp')"), 'unavailable');
      assert.equal(await win.webContents.executeJavaScript("spaceDesktop.saveBrowserVaultToken('https://api.githubcopilot.com/mcp/')"), 'saved');
      personalConnections = [{ url: 'https://api.githubcopilot.com/mcp/readonly' }];
      await win.spaceBrowser.showPanel();
      await first.loadURL('https://linear.app/team');
      await waitFor(bar, suggestion, 'Linear MCP');
      const guide = win.webContents.executeJavaScript(`new Promise(resolve => {
        const off = spaceDesktop.onBrowserMcpSetup(site => { off(); resolve(site); });
      })`);
      await click('#mcp-guide');
      assert.deepEqual(await guide, { name: 'Linear', url: 'https://mcp.linear.app/mcp', actor: 'alice', showGuide: true });
      await win.spaceBrowser.showPanel();
      await waitFor(bar, suggestion, 'Linear MCP');
      await click('#dismiss-mcp');
      await first.loadURL('https://github.com/owner/repo');
      await first.loadURL('https://linear.app/team');
      assert.equal(await bar.executeJavaScript("document.querySelector('#mcp-suggestion').hidden"), true);
      assert.ok(connectionChecks > checks);
      await first.loadURL('https://linear.app/login');
      const sidekick = win.webContents.executeJavaScript(`new Promise(resolve => {
        const off = spaceDesktop.onBrowserSidekick(tab => { off(); resolve(tab); });
      })`);
      await click('#sidekick');
      const vaultTab = await sidekick;
      const session = await win.webContents.executeJavaScript('spaceDesktop.browserSessionId(' + JSON.stringify(vaultTab.tab) + ',' + JSON.stringify(vaultWorkspace) + ')');
      const context = { session, workspace: vaultWorkspace, installation: vaultInstallation, page: 'https://linear.app/login' };
      const requestFill = (overrides = {}) => win.spaceBrowser.vaultTool({ action: 'fill', ...context, ...overrides }, AbortSignal.timeout(5000));
      const approved = { status: 'approved', username: 'test-login', password: 'test-secret' };
      let prompts = 0;
      testVault = async (_resources, request) => {
        prompts++;
        assert.equal(request.origin, 'https://linear.app'); assert.equal(request.agent, 'Kai Mac Codex');
        return approved;
      };
      assert.equal(await requestFill({ installation: vaultWorkspace }), 'unavailable');
      assert.equal(await requestFill({ page: 'https://linear.app/other' }), 'unavailable');
      assert.equal(prompts, 0);
      const allowLogin = testVault;
      testVault = async () => ({ status: 'cancelled' });
      assert.equal(await requestFill(), 'cancelled');
      assert.equal(await first.executeJavaScript("document.querySelector('[type=password]').value"), '');
      testVault = allowLogin;
      assert.equal(await requestFill(), 'filled');
      assert.equal(await first.executeJavaScript("document.querySelector('[type=password]').value === 'test-secret'"), true);
      assert.equal(await requestFill(), 'manual_control');
      assert.equal(prompts, 1);
      await send('agent', 'Read the page');
      assert.equal(await bar.executeJavaScript("document.querySelector('#ask').disabled"), true);
      await click('#resume-control');
      await first.loadURL('https://linear.app/login');
      testVault = async () => {
        await first.loadURL('https://linear.app/login');
        return approved;
      };
      assert.equal(await requestFill(), 'unavailable', 'a same-URL reload invalidates approval');
      assert.equal(await first.executeJavaScript("document.querySelector('[type=password]').value"), '');
      await first.executeJavaScript("document.querySelector('form').action='https://other.example/login'");
      testVault = async () => approved;
      assert.equal(await requestFill(), 'manual_control');
      assert.equal(await first.executeJavaScript("document.querySelector('[type=password]').value"), '');
      await click('#resume-control');
      const item = 'd920ebbe-c6e2-4edb-944f-f07bb81182b4';
      const { RemoteMcp } = require('../dist/runner/remote.cjs');
      const methods = { discover: RemoteMcp.prototype.discover, call: RemoteMcp.prototype.call };
      const catalog = [{ name: 'issue_read', inputSchema: { type: 'object' } }];
      const issued = [];
      try {
        RemoteMcp.prototype.discover = async c => { assert.deepEqual(c, { url: 'https://mcp.linear.app/mcp', token: 'fake-api-token' }); return catalog; };
        RemoteMcp.prototype.call = async (c, name, args) => {
          assert.equal(c.token, 'fake-api-token'); issued.push([name, args]); return { content: [{ type: 'text', text: 'Issue title' }] };
        };
        testVault = async (_resources, request) => {
          assert.equal(request.agent, 'Kai Mac Codex');
          assert.equal(request.endpoint, 'https://mcp.linear.app/mcp');
          if (request.action === 'call-api') assert.equal(request.item, item);
          return { status: 'approved', item, token: 'fake-api-token' };
        };
        const list = await requestFill({ id: 'turn-a', action: 'list-api' });
        assert.deepEqual(list, { status: 'ready', tools: catalog });
        const call = { id: 'turn-a', action: 'call-api', input: { tool: 'issue_read', arguments: { id: 'ENG-42' } } };
        assert.equal(await requestFill({ ...call, id: 'turn-b' }), 'unavailable');
        assert.equal(await requestFill({ ...call, input: { tool: 'issue_write', arguments: {} } }), 'unavailable');
        assert.deepEqual(await requestFill(call), { status: 'completed', result: { content: [{ type: 'text', text: 'Issue title' }] } });
        assert.deepEqual(issued, [['issue_read', { id: 'ENG-42' }]]);
      } finally { Object.assign(RemoteMcp.prototype, methods); }
    } finally {
      first.session.protocol.unhandle('https');
      await first.loadURL(base + '/report');
    }
  }
  const observeSidekick = () => win.webContents.executeJavaScript(`new Promise(resolve => {
    const unsubscribe = spaceDesktop.onBrowserSidekick(tab => {unsubscribe(); resolve(tab);});
  })`);
  await first.executeJavaScript("history.replaceState(null,'','/report?private=yes#details')");
  const opening = observeSidekick();
  await click('#sidekick');
  const handoff = await opening;
  assert.deepEqual({page:handoff.page,actor:handoff.actor},{page:base+'/report',actor:'alice'});
  const sessionFor = (workspace) => win.webContents.executeJavaScript(
    'spaceDesktop.browserSessionId(' + JSON.stringify(handoff.tab) + ',' + JSON.stringify(workspace) + ')');
  const tabSession = await sessionFor(assetId);
  assert.match(tabSession,/^[a-f0-9-]{36}$/);
  assert.notEqual(await sessionFor('8485b2a9-59fa-4ff0-aa50-762f2a074759'),tabSession);
  const dismissed = observeSidekick();
  await win.webContents.executeJavaScript('spaceDesktop.dismissBrowserSidekick('+JSON.stringify(handoff.tab)+')');
  assert.equal(await dismissed,null);
  assert.equal(await sessionFor(assetId),null);
  const reopening = observeSidekick();
  await click('#sidekick');
  assert.deepEqual(await reopening,handoff);
  assert.equal(await sessionFor(assetId),tabSession);
  const navigation = observeSidekick();
  await first.executeJavaScript("history.replaceState(null,'','/report/new?private=yes')");
  assert.deepEqual(await navigation,{...handoff,page:base+'/report/new'});
  await first.executeJavaScript("history.replaceState(null,'','/report')");

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
    const original = dialog.showMessageBox;
    let prompts = 0;
    try {
      dialog.showMessageBox = async (_win, options) => {
        assert.equal(options.message, 'Install Web Browser?');
        prompts++;
        return { response: 0 };
      };
      await win.spaceBrowser.open(true);
      assert.equal(prompts, 1, 'a second account must install its own browser plugin');
    } finally { dialog.showMessageBox = original; }
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
