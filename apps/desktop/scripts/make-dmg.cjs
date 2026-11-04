const { execFile } = require('node:child_process');
const { cp, mkdir, mkdtemp, rm, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { promisify } = require('node:util');
const run = promisify(execFile);

// Use the macOS system tool so installer creation needs no native Node addons.
async function makeDmg(arch) {
  if (!['arm64', 'x64', 'universal'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  const root = resolve(__dirname, '..');
  const staging = await mkdtemp(join(tmpdir(), 'space-dmg-'));
  const output = join(root, 'out', 'make', `Space-${arch}.dmg`);
  try {
    await mkdir(join(root, 'out', 'make'), { recursive: true });
    await cp(join(root, 'out', `Space-darwin-${arch}`, 'Space.app'), join(staging, 'Space.app'), { recursive: true, verbatimSymlinks: true });
    await symlink('/Applications', join(staging, 'Applications'));
    await run('/usr/bin/hdiutil', ['create', '-volname', 'Space', '-srcfolder', staging, '-format', 'UDZO', '-ov', output], { timeout: 120_000 });
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

module.exports = { makeDmg };
