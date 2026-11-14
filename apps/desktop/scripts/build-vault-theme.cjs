const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

// SwiftUI uses the same semantic colors as @space/ui. Resolve them when compiling the addon.
async function buildVaultTheme(output) {
  const css = await readFile(join(__dirname, '../../../packages/ui/src/styles/tokens.css'), 'utf8');
  const tokens = ['surface', 'surface-raised', 'surface-subtle', 'surface-hover', 'text', 'text-secondary',
    'border', 'border-strong', 'accent', 'accent-soft', 'on-accent', 'success', 'success-hover', 'on-success',
    'sidebar', 'sidebar-text', 'sidebar-selection', 'sidebar-content-active', 'focus', 'danger'];
  function colors(theme) {
    const start = css.indexOf('[data-theme="' + theme + '"] {');
    const block = css.slice(start, css.indexOf('}', start));
    return Object.fromEntries([...block.matchAll(/--sp-([\w-]+):\s*#([0-9a-f]{6});/gi)].map(([, name, hex]) => [name, hex]));
  }
  const light = colors('light'), dark = colors('dark');
  const definitions = tokens.map(name => {
    if (!light[name] || !dark[name]) throw new Error('Missing Vault theme color: ' + name);
    const property = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return '    static let ' + property + ' = adaptive(0x' + light[name] + ', 0x' + dark[name] + ')';
  });
  await writeFile(output, 'import SwiftUI\nextension VaultStyle {\n' + definitions.join('\n') + '\n}\n');
}
if (require.main === module) buildVaultTheme(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildVaultTheme };
