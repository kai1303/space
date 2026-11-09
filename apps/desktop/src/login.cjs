const { BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');

// Give interactive provider CLIs a real macOS PTY. Only this bundled local page
// can read its output or send input. The workspace renderer never sees credentials.
async function providerLogin(resources, provider, { command, args, env }, signal) {
  const win = new BrowserWindow({
    title: `Sign in to ${provider}`, width: 790, height: 540, resizable: false, show: false,
    webPreferences: { preload: join(resources, 'login-preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, partition: 'space-local-sign-in' },
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  const abort = () => { if (!win.isDestroyed()) win.destroy(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await win.loadFile(join(resources, 'login.html'));
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/expect', ['-f', join(resources, 'login.exp'), command, ...args], {
        cwd: env.HOME, env: { ...env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const timeout = setTimeout(abort, 10 * 60_000);
      win.once('closed', () => { child.stdin.end(); child.kill(); });
      child.stdin.on('error', () => {});
      contents.mainFrame.ipc.on('login-input', (_event, value) => {
        if (typeof value === 'string' && value.length <= 8192 && child.stdin.writable) child.stdin.write(value);
      });
      let bytes = 0;
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8').on('data', value => {
          bytes += Buffer.byteLength(value);
          if (bytes > 2_000_000) abort();
          else if (!win.isDestroyed()) contents.send('login-output', value);
        });
      }
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timeout);
        resolve(code === 0 && !win.isDestroyed());
      });
      win.show();
    });
  } finally { signal.removeEventListener('abort', abort); abort(); }
}
module.exports = { providerLogin };
