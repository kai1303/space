import type { LocalProvider } from '@space/contracts';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Registration { client_id: string; subject: string; issuer: string }
export interface Credentials extends Registration {
  access_token: string; refresh_token: string; id_token: string;
  scopes: string[]; expires_at: number;
}
export interface Connection { provider?: LocalProvider; origin: string; credential: string; installation_id: string; workspace_id: string }
export interface LocalState {
  host_id: string;
  project_key?: string;
  pending?: { origin: string; credential: string; code_hash: string };
  connection?: Connection;
  registration?: Registration;
  credentials?: Credentials;
}

export function platformOrigin(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Platform URL must be an origin without credentials, path, query, or fragment.');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Use HTTPS, or HTTP on a loopback host for local development.');
  return url.origin;
}

export class ConnectorStore {
  constructor(readonly directory = join(homedir(), '.config', 'space-connector')) {}
  private async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Connector storage must be a private directory, not a symlink.');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Connector storage must be owned by the current user.');
    await chmod(this.directory, 0o700);
  }
  async load(): Promise<LocalState> {
    await this.prepare();
    try {
      const file = await open(join(this.directory, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await file.chmod(0o600);
        const state = JSON.parse(await file.readFile('utf8')) as LocalState;
        if (!/^urn:uuid:[0-9a-f-]{36}$/.test(state.host_id)) throw new Error('Invalid connector state.');
        return state;
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const state: LocalState = { host_id: `urn:uuid:${randomUUID()}` };
      await this.save(state);
      return state;
    }
  }
  async save(state: LocalState) {
    await this.prepare();
    const temporary = join(this.directory, `.state-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally { await file.close(); }
    try { await rename(temporary, join(this.directory, 'state.json')); }
    finally { await rm(temporary, { force: true }); }
  }
  async lock(): Promise<() => Promise<void>> {
    await this.prepare();
    const path = join(this.directory, 'connector.lock');
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Do not steal a live process's lock: refresh tokens rotate and must have one writer.
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Connector lock is invalid. Remove it only after stopping every connector process.');
      try { process.kill(pid, 0); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
          throw new Error(`The previous connector did not shut down cleanly. After confirming no connector is running, remove ${path} and retry.`);
        }
      }
      throw new Error('A connector is already running with this local storage.');
    }
    return async () => { await rm(path, { force: true }); };
  }
}
