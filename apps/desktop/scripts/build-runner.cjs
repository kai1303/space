const { build } = require('esbuild');
const { mkdir, copyFile, mkdtemp, rm } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const root = join(__dirname, '..');
const destination = join(root, 'dist', 'runner');

async function buildRunner() {
  await mkdir(destination, { recursive: true });
  if (process.platform === 'darwin') {
    const compile = require('node:util').promisify(require('node:child_process').execFile);
    const sources = (...names) => names.map(name => join(root, 'vault', name));
    const temp = await mkdtemp(join(require('node:os').tmpdir(), 'space-vault-build-'));
    try {
      const theme = join(temp, 'VaultColors.swift');
      await require('./build-vault-theme.cjs').buildVaultTheme(theme);
      const fonts = dirname(require.resolve('@fontsource/lato/400.css'));
      for (const file of ['lato-latin-400-normal.woff2', 'lato-latin-700-normal.woff2']) {
        await copyFile(join(fonts, 'files', file), join(destination, file));
      }
      await copyFile(join(fonts, 'LICENSE'), join(destination, 'Lato-LICENSE.txt'));
      const object = join(temp, 'bridge.o');
      const headers = join(dirname(process.execPath), '../include/node');
      await compile('xcrun', ['clang', '-DNAPI_VERSION=8', '-I', headers, '-c', ...sources('bridge.c'), '-o', object]);
      await compile('xcrun', ['swiftc', '-O', '-emit-library', '-Xlinker', '-undefined', '-Xlinker', 'dynamic_lookup',
        ...sources('VaultStore.swift', 'VaultEditor.swift', 'VaultManager.swift', 'EmbeddedVault.swift', 'VaultStyle.swift'), theme, object, '-o', join(destination, 'space-vault.node')]);
      await compile('xcrun', ['swiftc', '-O', ...sources('main.swift', 'Keychain.swift', 'VaultStore.swift'), '-o', join(destination, 'space-vault')]);
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  await build({
    entryPoints: ['runtime', 'office-mcp', 'browser-mcp'].map(name => join(root, 'runner', name + '.mjs')), bundle: true, platform: 'node', format: 'esm',
    target: 'node24', outdir: destination, outExtension: { '.js': '.mjs' },
    // Resolve workspace contracts from source so a clean checkout builds directly.
    alias: { '@space/contracts': join(root, '../..', 'packages/contracts/index.ts') },
    banner: { js: "import {createRequire as createNodeRequire} from 'node:module'; const require = createNodeRequire(import.meta.url);" },
  });
  await build({
    entryPoints: [join(root, '../mcp-gateway/remote.ts')], bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', outfile: join(destination, 'remote.cjs'),
    alias: { '@space/contracts': join(root, '../../packages/contracts/index.ts') },
  });
  for (const [source, name] of [
    [join(root, '../../packages/contracts/local-providers.json'), 'local-providers.json'],
    [require.resolve('@xterm/xterm'), 'xterm.js'],
    [require.resolve('@xterm/xterm/css/xterm.css'), 'xterm.css'],
    ...['worker.mjs', 'login.exp', 'login.html', 'login.js', 'login-preload.cjs'].map(name => [join(root, 'runner', name), name]),
  ]) await copyFile(source, join(destination, name));
}

if (require.main === module) buildRunner().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildRunner };
