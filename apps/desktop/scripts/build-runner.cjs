const { build } = require('esbuild');
const { mkdir, copyFile } = require('node:fs/promises');
const { join } = require('node:path');
const root = join(__dirname, '..');
const destination = join(root, 'dist', 'runner');

async function buildRunner() {
  await mkdir(destination, { recursive: true });
  await build({
    entryPoints: [join(root, 'runner/runtime.mjs')], bundle: true, platform: 'node', format: 'esm',
    target: 'node24', outfile: join(destination, 'runtime.mjs'),
    // Resolve workspace contracts from source so a clean checkout builds directly.
    alias: { '@space/contracts': join(root, '../..', 'packages/contracts/index.ts') },
    banner: { js: "import {createRequire as createNodeRequire} from 'node:module'; const require = createNodeRequire(import.meta.url);" },
  });
  for (const [source, name] of [
    [require.resolve('@xterm/xterm'), 'xterm.js'],
    [require.resolve('@xterm/xterm/css/xterm.css'), 'xterm.css'],
    ...['worker.mjs', 'login.exp', 'login.html', 'login.js', 'login-preload.cjs'].map(name => [join(root, 'runner', name), name]),
  ]) await copyFile(source, join(destination, name));
}

if (require.main === module) buildRunner().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildRunner };
