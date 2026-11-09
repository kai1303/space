const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { constants, existsSync, accessSync, statSync, openSync, readFileSync, closeSync, unlinkSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');
const { homedir } = require('node:os');

const providers = new Map([['codex', 'codex'], ['kiro', 'kiro-cli'], ['claude', 'claude']]);
function validatePair(provider, code) {
  if (!providers.has(provider) || typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('Invalid desktop pairing request.');
}

function runnerPath() {
  return [...new Set([...(process.env.PATH || '').split(':'), join(homedir(), '.local/bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/Applications/Codex.app/Contents/Resources']
    .filter(path => isAbsolute(path)))].join(':');
}

// Desktop alone owns this profile under Electron's single-instance userData directory.
// A hard-killed worker can leave its PID behind. Never remove a live writer's lock.
function recoverStoppedWorker(directory) {
  const path = join(directory, 'connector.lock');
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let pid;
  try { pid = Number(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') unlinkSync(path); }
}

function createRunners({ origin, userData, resources, login, notify }) {
  const root = join(userData, 'local-runners', createHash('sha256').update(origin).digest('hex'));
  const running = new Map();
  let stopping = false;

  function start(provider, code) {
    if (stopping || running.has(provider)) throw new Error('This provider is already running. Disconnect its current agent before pairing again.');
    const path = runnerPath();
    const executable = providers.get(provider);
    if (!path.split(':').some(dir => {
      try { const file = join(dir, executable); accessSync(file, constants.X_OK); return statSync(file).isFile(); }
      catch { return false; }
    })) throw new Error(`Install ${executable} on this Mac, then try connecting again.`);
    const directory = join(root, provider);
    recoverStoppedWorker(directory);
    const child = fork(join(resources, 'worker.mjs'), [], {
      cwd: resources, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { HOME: homedir(), LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, PATH: path, ELECTRON_RUN_AS_NODE: '1' },
    });
    const controller = new AbortController();
    let finish, fail;
    const claimed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    let acknowledged = !code;
    if (acknowledged) finish();
    const timeout = code && setTimeout(() => { fail(new Error('Desktop pairing timed out. Check your workspace connection and retry.')); child.kill(); }, 25_000);
    let failure;
    child.on('error', () => { failure = 'Space could not start the bundled connector.'; fail(new Error(failure)); });
    child.on('message', async message => {
      if (stopping) return;
      if (message.type === 'paired') { acknowledged = true; clearTimeout(timeout); finish(); }
      if (message.type === 'failure') failure = String(message.message).slice(0, 500);
      if (message.type === 'login') {
        let success = false;
        try { success = await login(resources, provider, message, controller.signal); } catch {}
        if (child.connected) child.send(success ? 'signed-in' : 'cancelled', () => {});
      }
    });
    const closed = new Promise(resolve => child.once('close', () => {
      clearTimeout(timeout);
      controller.abort();
      running.delete(provider);
      if (!acknowledged) fail(new Error(failure || 'The connector stopped before pairing completed.'));
      else if (failure && !stopping) notify(provider, failure);
      resolve();
    }));
    running.set(provider, { child, closed, controller });
    child.send({ provider, code, origin, directory });
    return claimed;
  }

  return {
    start,
    restore() {
      for (const provider of providers.keys()) {
        if (!existsSync(join(root, provider, 'paired'))) continue;
        try { void start(provider).catch(error => notify(provider, error.message)); }
        catch (error) { notify(provider, error.message); }
      }
    },
    async stop() {
      stopping = true;
      await Promise.all([...running.values()].map(async ({ child, closed, controller }) => {
        controller.abort();
        child.kill();
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { await closed; } finally { clearTimeout(timer); }
      }));
    },
  };
}
module.exports = { createRunners, validatePair, recoverStoppedWorker };
