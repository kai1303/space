// Opt-in local integration test. Never attaches to a user's existing Electron profile.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { once } = require('node:events');
const { app, session } = require('electron');
const { createSpaceWindow } = require('../src/window.cjs');
const { spaceUrl } = require('../src/policy.cjs');
const { faultProxy } = require('./fault-proxy.cjs');

app.setPath('userData', process.env.SPACE_SMOKE_PROFILE);
app.on('window-all-closed', () => {});
const fixturePath = join(process.env.SPACE_SMOKE_PROFILE, 'live-fixture.json');
let win;
let proxy;
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
// Observe UI mutations with a deadline; do not poll the app or its API.
const waitForText = text => evaluate(expected => new Promise((resolve, reject) => {
  const check = () => { if (document.body.textContent.includes(expected)) { observer.disconnect(); clearTimeout(deadline); resolve(); } };
  const observer = new MutationObserver(check);
  const deadline = setTimeout(() => { observer.disconnect(); reject(new Error(`UI did not show: ${expected}`)); }, 35_000);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  check();
}), text);

app.whenReady().then(async () => {
  const url = spaceUrl(process.env.SPACE_DESKTOP_TEST_URL);
  const origin = new URL(url).origin;
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Live QA requires an explicit loopback deployment');
  const api = async (path, body, cookie) => {
    const response = await fetch(`${origin}/v1${path}`, {
      method: body ? 'POST' : 'GET', headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
    assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`);
    return { data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  };
  let fixture;
  if (process.env.SPACE_SMOKE_PHASE === 'initial') {
    const suffix = randomUUID().slice(0, 8), password = `Desktop-QA-${randomUUID()}!`;
    const email = `desktop-recovery-${suffix}@example.test`;
    const owner = await api('/auth/sign-up/email', { name: 'Desktop Recovery QA', email, password });
    const peer = await api('/auth/sign-up/email', { name: 'Desktop Recovery Peer', email: `desktop-recovery-peer-${suffix}@example.test`, password });
    const workspace = (await api('/workspaces', { name: `Desktop Recovery QA ${suffix}` }, owner.cookie)).data;
    const channel = (await api(`/workspaces/${workspace.id}/channels`, { name: 'recovery-check', private: true }, owner.cookie)).data;
    await api(`/workspaces/${workspace.id}/members`, { user_id: peer.data.user.id, role: 'member' }, owner.cookie);
    await api(`/channels/${channel.id}/members`, { user_id: peer.data.user.id }, owner.cookie);
    fixture = { email, password, owner, peer, workspace, channel, message: `Recovered desktop message ${suffix}` };
    writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
  } else fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  proxy = await faultProxy(origin);
  await session.fromPartition('persist:space').setProxy({ proxyRules: proxy.address, proxyBypassRules: '<-loopback>' });
  win = createSpaceWindow(url, { show: false });
  await once(win.webContents, 'did-finish-load');
  if (process.env.SPACE_SMOKE_PHASE === 'initial') {
    const status = await evaluate(async (email, password) => (await fetch('/v1/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    })).status, fixture.email, fixture.password);
    assert.equal(status, 200);
    const loaded = once(win.webContents, 'did-finish-load'); win.reload(); await loaded;
  }
  await waitForText(fixture.workspace.name);
  console.log(`QA (${process.env.SPACE_SMOKE_PHASE}): workspace loaded`);
  if (process.env.SPACE_SMOKE_PHASE === 'initial') {
    await waitForText('This is the beginning of #recovery-check');
    await proxy.connected();
    console.log('QA: cutting the test profile connection');
    proxy.disconnect();
    assert.equal(await evaluate(async () => { try { await fetch('/v1/me'); return false; } catch { return true; } }), true, 'renderer is offline');
    const input = { client_message_id: randomUUID(), text: fixture.message };
    const path = `/channels/${fixture.channel.id}/messages`;
    const first = (await api(path, input, fixture.peer.cookie)).data;
    const retry = (await api(path, input, fixture.peer.cookie)).data;
    assert.equal(first.id, retry.id, 'retry after a lost acknowledgment cannot duplicate the message');
    proxy.reconnect();
    console.log('QA: reconnecting after sending an offline message');
    await waitForText(fixture.message);
    const count = await evaluate(text => {
      const timeline = document.querySelector('[aria-label="Messages in recovery-check"]');
      return timeline.textContent.split(text).length - 1;
    }, fixture.message);
    assert.equal(count, 1, 'replayed message appears once');
    const unread = (await api(`/workspaces/${fixture.workspace.id}/unread`, undefined, fixture.owner.cookie)).data;
    assert.equal(unread.channels.find(channel => channel.channel_id === fixture.channel.id).unread_count, 1, 'hidden desktop window must not mark messages read');
    await win.webContents.session.cookies.flushStore();
    console.log('PASS (initial): real API login, offline/reconnect replay, duplicate suppression, hidden-window unread state');
  } else {
    await waitForText(fixture.message);
    assert.equal(await evaluate(async () => (await fetch('/v1/me')).status), 200, 'authenticated session survives process restart');
    await api('/auth/revoke-sessions', {}, fixture.owner.cookie);
    await waitForText('Welcome back.');
    assert.equal(await evaluate(text => document.body.textContent.includes(text), fixture.message), false, 'revocation clears private conversation UI');
    console.log('PASS (restart): authenticated restart, saved history, live session revocation clears private UI');
  }
  win.destroy(); proxy.close(); app.exit(0);
}).catch(error => {
  console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  proxy?.close();
  app.exit(1);
});
