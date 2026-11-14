import { runNativeLogin } from './native-login.js';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access, realpath} from 'node:fs/promises';
import {delimiter, join} from 'node:path';
import {promisify} from 'node:util';
import {ensureDirectory} from './session-storage.js';
import type {Registration} from './storage.js';

export interface LocalClaudeAuth { command: string; directory: string; identity: Registration }

export async function resolveClaudeCommand() {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      const command = await realpath(join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude'));
      await access(command, constants.X_OK);
      return command;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('Install Claude Code on PATH before connecting Claude.');
}

export async function claudeEnvironment(directory: string) {
  const home = await ensureDirectory(join(directory, 'claude-home'));
  return { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, SystemRoot: process.env.SystemRoot,
    HOME: home, CLAUDE_CONFIG_DIR: await ensureDirectory(join(home, '.claude')) };
}

export function parseClaudeIdentity(output: string): Registration {
  const account = JSON.parse(output);
  if (account.loggedIn !== true || !['claude.ai', 'api_key', 'api_key_helper', 'third_party', 'oauth_token'].includes(account.authMethod) || typeof account.email !== 'string' || !account.email || account.email.length > 320 || (account.orgId !== undefined && typeof account.orgId !== 'string')) {
    throw new Error('Claude sign-in is required. Restart with --provider claude --login.');
  }
  return { issuer: 'claude-code', client_id: 'space-claude-local', subject: createHash('sha256').update(JSON.stringify([account.authMethod, account.email, account.orgId ?? ''])).digest('hex') };
}

export async function claudeIdentity(directory: string, signal: AbortSignal): Promise<LocalClaudeAuth> {
  const command = await resolveClaudeCommand();
  const env = await claudeEnvironment(directory);
  try {
    const result = await promisify(execFile)(command, ['auth', 'status'], { cwd: env.HOME, env, signal, timeout: 15_000, maxBuffer: 32_000 });
    return {command, directory, identity: parseClaudeIdentity(result.stdout)};
  } catch { throw new Error('Claude sign-in is required. Restart with --provider claude --login.'); }
}

export async function claudeLoginCommand(directory: string, logout = false) {
  const command = await resolveClaudeCommand();
  return { command, args: ['auth', logout ? 'logout' : 'login'], env: await claudeEnvironment(directory) };
}
export async function claudeLogin(directory: string, signal: AbortSignal, logout = false) {
  await runNativeLogin(await claudeLoginCommand(directory, logout), signal, 'Claude');
}
