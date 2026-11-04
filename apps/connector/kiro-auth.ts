import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, open, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ensureDirectory } from './session-storage.js';
import type { Registration } from './storage.js';

export async function resolveKiroAcpCommand(path = process.env.PATH ?? '') {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    let executable: string;
    try {
      executable = await realpath(join(directory, 'kiro-cli'));
      await access(executable, constants.X_OK);
    } catch { continue; }
    // The split CLI launcher searches HOME/.local/bin, which is intentionally isolated.
    const helper = join(dirname(executable), 'kiro-cli-chat');
    try { await access(helper, constants.X_OK); return helper; }
    catch { return executable; }
  }
  throw new Error('Could not find Kiro CLI on PATH.');
}

export async function kiroEnvironment(directory: string) {
  const home = await ensureDirectory(join(directory, 'kiro-home'));
  return { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, HOME: home,
    XDG_CONFIG_HOME: await ensureDirectory(join(home, '.config')),
    XDG_DATA_HOME: await ensureDirectory(join(home, '.local')) };
}
export async function prepareKiroProfile(directory: string) {
  const env = await kiroEnvironment(directory);
  const root = await ensureDirectory(join(env.HOME, '.kiro'));
  const agents = await ensureDirectory(join(root, 'agents'));
  const temporary = join(agents, `.space-chat-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ name: 'space-chat', description: 'Space chat without tools',
      prompt: 'Respond using only the supplied Space task, quoted context and retained conversation. Do not access local files, run commands, or use external tools.',
      tools: [], excludedTools: ['*'], mcpServers: {}, includeMcpJson: false, includePowers: false, resources: [], hooks: {},
    }));
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, join(agents, 'space-chat.json')); }
  finally { await rm(temporary, { force: true }); }
  return env;
}
export function parseKiroIdentity(output: string): Registration {
  // Some CLI versions append a human-readable profiles list after the JSON line.
  const value = JSON.parse(output.split('\n').find(line => line.trim().startsWith('{')) ?? '');
  if (typeof value.accountType !== 'string' || !value.accountType || typeof value.email !== 'string' || !value.email || value.email.length > 320) throw new Error('Kiro account identity is unavailable.');
  for (const key of ['region', 'startUrl']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error('Kiro account identity is invalid.');
  const subject = createHash('sha256').update(JSON.stringify([value.accountType, value.email, value.region ?? '', value.startUrl ?? ''])).digest('hex');
  return { issuer: 'kiro', subject, client_id: 'space-kiro' };
}
export async function kiroIdentity(directory: string, signal: AbortSignal) {
  try {
    const env = await kiroEnvironment(directory);
    const result = await promisify(execFile)('kiro-cli', ['whoami', '--format', 'json'], { cwd: env.HOME, env, signal, timeout: 15_000, maxBuffer: 32_000 });
    return parseKiroIdentity(result.stdout);
  } catch { throw new Error('Kiro sign-in is required. Restart with --provider kiro --login.'); }
}
export async function kiroLogin(directory: string, signal: AbortSignal, logout = false) {
  const env = await kiroEnvironment(directory);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('kiro-cli', [logout ? 'logout' : 'login'], { cwd: env.HOME, env, stdio: 'inherit', signal });
    child.once('error', () => reject(new Error('Could not start Kiro. Install the Kiro CLI and retry.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Kiro sign-in or sign-out did not complete.')));
  });
}
