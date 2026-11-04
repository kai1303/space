import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKiroIdentity } from '../dist/kiro-auth.js';
import { connectorDirectory } from '../dist/main.js';
test('Kiro identity is stable, account-bound, and excludes credentials and displayed profiles', () => {
 const raw={accountType:'BuilderId',email:'user@example.test',region:'us-east-1'};
 const identity=parseKiroIdentity(JSON.stringify(raw)+'\n\nProfiles:\nother-account');
 assert.equal(identity.subject.length,64);assert.ok(!JSON.stringify(identity).includes(raw.email));
 assert.deepEqual(identity,parseKiroIdentity(JSON.stringify({...raw,token:'never-read',displayName:'Changed'})));
 assert.notEqual(identity.subject,parseKiroIdentity(JSON.stringify({...raw,email:'other@example.test'})).subject);
 for(const value of [{},{...raw,email:''},{...raw,startUrl:{}}])assert.throws(()=>parseKiroIdentity(JSON.stringify(value)));
 assert.notEqual(connectorDirectory('kiro'),connectorDirectory('codex'));
 assert.ok(connectorDirectory('codex').endsWith('/space-connector'));
});

test('ACP resolves the installed chat helper before changing HOME', async () => {
  const { resolveKiroAcpCommand } = await import('../dist/kiro-auth.js');
  const { mkdir, writeFile, symlink, mkdtemp, rm, realpath } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kiro-binaries-')));
  try {
    await mkdir(join(directory, 'bin')); await mkdir(join(directory, 'app'));
    await writeFile(join(directory, 'app', 'kiro-cli'), '', { mode: 0o700 });
    await writeFile(join(directory, 'app', 'kiro-cli-chat'), '', { mode: 0o700 });
    await symlink(join(directory, 'app', 'kiro-cli'), join(directory, 'bin', 'kiro-cli'));
    assert.equal(await resolveKiroAcpCommand(join(directory, 'bin')), join(directory, 'app', 'kiro-cli-chat'));
    await rm(join(directory, 'app', 'kiro-cli-chat'));
    assert.equal(await resolveKiroAcpCommand(join(directory, 'bin')), join(directory, 'app', 'kiro-cli'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
