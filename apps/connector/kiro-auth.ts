import { runNativeLogin } from './native-login.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, open, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ensureDirectory } from './session-storage.js';
import { projectMcp, projectServer, projectToolNames } from './project-tools.js';
import { codingInstructions, kiroCodingTools } from './coding-tools.js';
import { serverPrompt, type TurnServer } from './outbound-tools.js';
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
export async function prepareKiroProfile(directory: string, project?: string, servers: TurnServer[] = [], coding = false) {
  if (coding && !project) throw new Error('Coding requires --project.');
  const mode = coding ? 'space-coding' : 'space-chat';
  const env = await kiroEnvironment(directory);
  const allowed = [...(project && !coding ? projectToolNames.map(name => `${projectServer}/${name}`) : []), ...servers.flatMap(s => s.tools.map(name => `${s.name}/${name}`))];
  const root = await ensureDirectory(join(env.HOME, '.kiro'));
  const agents = await ensureDirectory(join(root, 'agents'));
  const temporary = join(agents, `.${mode}-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ name: mode, description: coding ? 'Space coding with owner approvals' : servers.length ? 'Space explicitly granted MCP tools' : project ? 'Space project file tools' : 'Space chat without tools',
      prompt: coding ? codingInstructions(project!) : servers.length ? serverPrompt(servers, project) : project ? `Work on the supplied Space task in the project ${project}. Use only the ${projectServer} MCP file tools for project inspection and edits. Native tools, shell and other integrations are unavailable.` : 'Respond using only the supplied Space task, quoted context and retained conversation. Do not access local files, run commands, or use external tools.',
      tools: [...(coding ? kiroCodingTools : []), ...allowed.map(name => `@${name}`)], excludedTools: coding || allowed.length ? [] : ['*'], mcpServers: { ...(project && !coding ? { [projectServer]: projectMcp(project) } : {}), ...Object.fromEntries(servers.map(s => [s.name, { url: s.url, headers: { Authorization: 'Bearer ${' + s.tokenEnv + '}' }, timeout: 35000 }])) },
      ...(coding ? { permissions: { rules: [...['fs_read', 'fs_write', 'shell'].map(capability => ({ capability, effect: 'ask' })), ...['web_fetch', 'web_search', 'subagent', 'skill', 'power', 'context'].map(capability => ({ capability, effect: 'deny' })), ...(allowed.length ? [{ capability: 'mcp', match: allowed, effect: 'allow' }] : [{ capability: 'mcp', effect: 'deny' }])] } } : allowed.length ? { permissions: { rules: [...['fs_read', 'fs_write', 'shell', 'web_fetch', 'web_search', 'subagent'].map(capability => ({ capability, effect: 'deny' })), { capability: 'mcp', match: allowed, effect: 'allow' }] } } : {}), includeMcpJson: false, includePowers: false, resources: [], hooks: {},
    }));
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, join(agents, `${mode}.json`)); }
  finally { await rm(temporary, { force: true }); }
  return { ...env, ...Object.fromEntries(servers.map(s => [s.tokenEnv, s.token])) };
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
export async function kiroLoginCommand(directory: string, logout = false) {
  return { command: 'kiro-cli', args: [logout ? 'logout' : 'login'], env: await kiroEnvironment(directory) };
}
export async function kiroLogin(directory: string, signal: AbortSignal, logout = false) {
  await runNativeLogin(await kiroLoginCommand(directory, logout), signal, 'Kiro');
}
