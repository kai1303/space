const { execFile } = require('node:child_process');
const { cp, copyFile, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } = require('node:fs/promises');
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
    const downloads = join(root, '../web/public/downloads');
    await mkdir(downloads, { recursive: true });
    const target = join(downloads, `Space-${arch}.dmg`);
    await copyFile(output, target + '.tmp');
    await rename(target + '.tmp', target);
    const files = await readdir(downloads);
    const builds = ['arm64', 'x64', 'universal'].filter(a => files.includes(`Space-${a}.dmg`));
    const manifest = join(downloads, 'macos.json');
    await writeFile(manifest + '.tmp', JSON.stringify(builds));
    await rename(manifest + '.tmp', manifest);
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

module.exports = { makeDmg };
