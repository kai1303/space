import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { uuid, type InvocationRequest } from '@space/contracts';
import { resolveProject } from './project-tools.js';
import type { Connection } from './storage.js';

const exec = promisify(execFile);
export function nativeFolderPicker() {
  if (process.platform === 'darwin') return async (signal: AbortSignal) => {
    const { stdout } = await exec('/usr/bin/osascript', ['-e',
      'try\nactivate\nreturn POSIX path of (choose folder with prompt "Choose a project for this Space coding session")\non error number -128\nreturn ""\nend try'],
    { signal, maxBuffer: 8192 });
    return stdout.replace(/\r?\n$/, '') || undefined;
  };
  if (process.platform === 'win32') return async (signal: AbortSignal) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Choose a project for this Space coding session"',
      'try { if ($dialog.ShowDialog() -eq "OK") { [Console]::Write($dialog.SelectedPath) } } finally { $dialog.Dispose() }',
    ].join('; ');
    const {stdout} = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {signal, maxBuffer:8192});
    return stdout || undefined;
  };
  if (process.platform !== 'linux' || !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) return;
  const directory = process.env.PATH?.split(delimiter).find(dir => {
    if (!isAbsolute(dir)) return false;
    try { accessSync(join(dir, 'zenity'), constants.X_OK); return true; } catch { return false; }
  });
  if (directory) return async (signal: AbortSignal) => {
    try {
      const { stdout } = await exec(join(directory, 'zenity'), ['--file-selection', '--directory', '--title=Choose a project for this Space coding session'], { signal, maxBuffer: 8192 });
      return stdout.replace(/\r?\n$/, '') || undefined;
    } catch (error) {
      if ((error as {code?: number}).code === 1 && !signal.aborted) return undefined;
      throw error;
    }
  };
}

// The platform stores an opaque selection. Only this pairing can resolve it, for this session.
function binding(connection: Connection, session: string) {
  return Buffer.from(JSON.stringify([connection.origin, connection.workspace_id, connection.installation_id, connection.credential, uuid(session)]));
}
function key(localKey?: string) {
  if (!localKey) throw new Error('Missing local project key.');
  return Buffer.from(localKey, 'base64url');
}
export async function selectSessionProject(connection: Connection, session: string, input: string, localKey: string) {
  const path = (await resolveProject(input))!;
  const { dev, ino } = await stat(path, {bigint: true});
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(localKey), iv);
  cipher.setAAD(binding(connection, session));
  const encrypted = cipher.update(JSON.stringify([path, String(dev), String(ino)]));
  return { name: basename(path) || path, project_token: Buffer.concat([iv, encrypted, cipher.final(), cipher.getAuthTag()]).toString('base64url') };
}

export class ProjectUnavailable extends Error {
  constructor() { super('The selected project is unavailable on this computer. Restore the folder or choose a folder in a new session.'); }
}
export async function projectForTurn<T extends { connection: Connection; project?: string; coding?: boolean; projectKey?: string }>(
  storage: T, request?: InvocationRequest,
): Promise<T> {
  const token = request?.persistent_session?.project_token;
  if (!token) return storage;
  try {
    const bytes = Buffer.from(token, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key(storage.projectKey), bytes.subarray(0, 12));
    cipher.setAAD(binding(storage.connection, request.session_id));
    cipher.setAuthTag(bytes.subarray(-16));
    const [path, dev, ino] = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString());
    const canonical = await resolveProject(path);
    const info = await stat(path, {bigint: true});
    if (canonical !== path || String(info.dev) !== dev || String(info.ino) !== ino) throw new Error();
    return { ...storage, project: path, coding: true };
  } catch {
    throw new ProjectUnavailable();
  }
}
