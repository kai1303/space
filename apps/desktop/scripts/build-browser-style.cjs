const { build } = require('esbuild');
const { join } = require('node:path');

function buildBrowserStyle() {
  return build({
    absWorkingDir: join(__dirname, '..'),
    entryPoints: ['src/browser/toolbar.css', 'src/browser/toolbar.js'],
    outdir: 'assets/browser-style',
    minify: true,
    bundle: true,
    loader: { '.woff2': 'file', '.woff': 'file' },
  });
}

if (require.main === module) buildBrowserStyle().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildBrowserStyle };
