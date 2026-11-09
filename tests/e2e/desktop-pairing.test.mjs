// Run after pnpm desktop:package on macOS. All accounts and provider responses are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { Server } from 'socket.io';

test('packaged Mac pairs, signs in locally, reports ready, restores, and stops after revocation', { timeout: 60000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'space-packaged-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const bin = join(folder, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'kiro-cli'), `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const profile = process.env.HOME + '/fixture-user';
switch (process.argv[2]) {
case 'whoami':
  if (!fs.existsSync(profile)) process.exit(1);
  console.log(JSON.stringify({accountType:'fixture',email:'test@example.invalid'}));
  break;
case 'login':
  if (!process.stdin.isTTY) process.exit(2);
  console.log('Fixture sign-in');
  readline.createInterface({input:process.stdin}).once('line', line => {
    if (line !== 'yes') process.exit(3);
    fs.writeFileSync(profile, 'signed in');
    process.exit(0);
  });
  break;
case 'acp':
  readline.createInterface({input:process.stdin}).on('line', line => {
    const {method,id} = JSON.parse(line);
    const result = method === 'initialize' ? {protocolVersion:1,agentCapabilities:{loadSession:true}} : {sessionId:'fixture',modes:{currentModeId:'space-chat'}};
    console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
  });
  break;
default: process.exit(4);
}`, { mode: 0o755 });
  const code = 'z'.repeat(32);
  let claims = 0, credential, revoked = false;
  const events = new EventEmitter();
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/agent-pairings/claim') { res.end('<!doctype html><title>Space fixture</title>'); return; }
    let data = '';
    for await (const chunk of req) data += chunk;
    const claim = JSON.parse(data);
    assert.equal(claim.code, code);
    assert.equal(claim.provider, 'kiro');
    claims++;
    credential = claim.credential;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ provider: 'kiro', workspace_id: 'workspace', installation_id: 'fixture' }));
  });
  const io = new Server(server);
  const agents = io.of('/agents');
  agents.use((socket, next) => next(socket.handshake.auth.token === credential && !revoked ? undefined : new Error('unauthorized')));
  agents.on('connection', socket => {
    socket.on('agent.heartbeat', ({auth_status}, ack) => {
      ack({data:{installation_id:'fixture'}});
      if (auth_status === 'ready') events.emit('ready', socket);
    });
    socket.on('agent.task.claim', (_request, ack) => ack({data:null}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => io.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = fileURLToPath(new URL(`../../apps/desktop/out/Space-darwin-${process.arch}/Space.app/Contents/MacOS/Space`, import.meta.url));
  let desktop;
  t.after(async () => { if (desktop) await desktop.close(); });
  async function launch() {
    desktop = await _electron.launch({ executablePath, cwd: folder, timeout: 10000,
      args: [`--user-data-dir=${join(folder, 'profile')}`],
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, SPACE_DESKTOP_URL: origin },
    });
    return desktop.firstWindow();
  }
  const waitReady = () => once(events, 'ready', { signal: AbortSignal.timeout(15000) });
  const page = await launch();
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({response:0}); });
  await desktop.evaluate(({ app }, origin) => app.emit('open-url', {preventDefault() {}},
    'space-desktop://connect?' + new URLSearchParams({origin,workspace:'workspace',provider:'kiro'})), origin);
  await page.waitForURL('**/chat?workspace=workspace&connectProvider=kiro');
  const signedIn = waitReady();
  const signInWindow = desktop.waitForEvent('window', {timeout:10000});
  await page.evaluate(code => window.spaceDesktop.pair('kiro', code), code);
  const login = await signInWindow;
  await login.locator('.xterm-helper-textarea').focus();
  await login.keyboard.type('yes');
  await login.keyboard.press('Enter');
  await signedIn;
  await assert.rejects(page.evaluate(code => window.spaceDesktop.pair('kiro', code), code), /already running/);
  await desktop.close(); desktop = undefined;
  const restored = waitReady();
  await launch();
  const [socket] = await restored;
  assert.equal(claims, 1);
  revoked = true;
  const roots = join(folder, 'profile', 'local-runners');
  const [key] = await readdir(roots);
  const dir = join(roots, key, 'kiro');
  const watcher = watch(dir);
  try {
    const stopped = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Revoked worker did not release its lock')), 10000);
      watcher.on('change', async (_kind, filename) => {
        if (filename === 'connector.lock' && !(await readdir(dir)).includes('connector.lock')) {
          clearTimeout(timeout); resolve();
        }
      });
    });
    socket.disconnect(true);
    await stopped;
    assert.equal((await readdir(dir)).includes('paired'), false);
  } finally { watcher.close(); }
});
