const { build } = require('esbuild');
const { join } = require('node:path');

function buildBrowserStyle() {
  const root = join(__dirname, '..');
  return Promise.all([build({
    absWorkingDir: root,
    entryPoints: ['src/browser/toolbar.css', 'src/browser/toolbar.js'],
    outdir: 'assets/browser-style',
    minify: true,
    bundle: true,
    loader: { '.woff2': 'file', '.woff': 'file' },
  }), build({
    absWorkingDir: root,
    entryPoints: ['src/browser/mcp-discovery.cjs'],
    outfile: 'assets/browser-style/mcp-discovery.cjs',
    platform: 'node',
    bundle: true,
    minify: true,
  })]);
}

if (require.main === module) buildBrowserStyle().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildBrowserStyle };
