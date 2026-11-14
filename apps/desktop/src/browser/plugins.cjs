const { mkdirSync, readdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const labels = { office: 'Office editor', browser: 'Web Browser' };

function bundledPlugins(userData, profileKey) {
  const directory = join(userData, 'plugins', profileKey);
  let entries = [];
  try { entries = readdirSync(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const active = new Set(entries.filter(id => Object.hasOwn(labels, id)));
  return {
    installed: () => [...active],
    has: id => active.has(id),
    set(id, enabled) {
      if (!Object.hasOwn(labels, id)) throw new Error('Unknown plugin.');
      if (active.has(id) === enabled) return;
      const file = join(directory, id);
      if (enabled) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(file, '', { mode: 0o600 });
        active.add(id);
      } else {
        unlinkSync(file);
        active.delete(id);
      }
    },
  };
}
module.exports = { bundledPlugins, labels };
