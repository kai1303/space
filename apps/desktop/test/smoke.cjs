const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const profile = mkdtempSync(join(tmpdir(), 'space-desktop-smoke-'));
const entry = process.argv[2] === 'live' ? 'live-app.cjs' : 'smoke-app.cjs';
async function run(phase) {
  const env = { ...process.env, SPACE_SMOKE_PROFILE: profile, SPACE_SMOKE_PHASE: phase };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [join(__dirname, entry)], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    const deadline = setTimeout(() => child.kill('SIGKILL'), entry === 'live-app.cjs' ? 120_000 : 30_000);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(deadline);
      if (code === 0 && output.includes(`PASS (${phase}):`)) resolve();
      else reject(new Error(`Electron smoke test exited with ${code}`));
    });
  });
}
(async () => {
  try {
    await run('initial');
    await run('restart');
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
