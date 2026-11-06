import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalProvider } from '@space/contracts';
import type { Connection, Registration } from './storage.js';

export interface LocalSessionStorage { directory: string; connection: Connection; identity: Registration; project?: string }

async function privateDirectory(path: string, create = true) {
  if (create) await mkdir(path, { mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Invalid private agent directory.');
  await chmod(path, 0o700);
  return path;
}

export async function ensureDirectory(path: string) {
  try { return await privateDirectory(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return privateDirectory(path, false);
  }
}

export async function localSessionStore(storage: LocalSessionStorage, provider: LocalProvider = 'codex') {
  const { connection, identity } = storage;
  const namespace = createHash('sha256').update(JSON.stringify([
    connection.origin, connection.workspace_id, connection.installation_id, connection.credential,
    identity.issuer, identity.subject, identity.client_id, ...(storage.project ? [storage.project] : []),
  ])).digest('hex');
  await privateDirectory(storage.directory, false); // ConnectorStore owns and locks this root.
  const root = await ensureDirectory(join(storage.directory, provider));
  const directory = await ensureDirectory(join(root, namespace));
  const home = await ensureDirectory(join(directory, 'home'));
  const cwd = await ensureDirectory(join(directory, 'work'));
  const sessions = await ensureDirectory(join(directory, 'sessions'));
  return {
    directory, home, cwd,
    async session(id: string, resume: boolean) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid Space session ID.');
      const session = join(sessions, id.toLowerCase());
      if (resume) await privateDirectory(session, false);
      else await ensureDirectory(session);
      const work = resume ? await privateDirectory(join(session, 'work'), false) : await ensureDirectory(join(session, 'work'));
      const path = join(session, 'thread.json');
      let threadId: string | undefined, ready = false;
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 4096 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Invalid agent session mapping.');
          await file.chmod(0o600);
          const mapping = JSON.parse(await file.readFile('utf8'));
          if (mapping.version !== 1 || typeof mapping.threadId !== 'string' || !mapping.threadId || mapping.threadId.length > 256 || (mapping.ready !== undefined && typeof mapping.ready !== 'boolean') || /[\u0000-\u001f\u007f]/.test(mapping.threadId)) throw new Error('Invalid agent session mapping.');
          threadId = mapping.threadId;
          ready = mapping.ready !== false; // Older mappings may already have run a turn.
        } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if ((resume && !threadId) || (!resume && threadId && ready)) throw new Error('Agent session mapping does not match the requested operation.');
      return {
        cwd: work, threadId, ready,
        async save(id: string, ready: boolean) {
          const temporary = join(session, `.thread-${randomUUID()}`);
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(JSON.stringify({ version: 1, threadId: id, ready })); await file.sync(); }
          finally { await file.close(); }
          try { await rename(temporary, path); }
          finally { await rm(temporary, { force: true }); }
        },
      };
    },
  };
}
