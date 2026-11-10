import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { request } from '../api/request.js';
import { workspaceReadVersion } from './live-updates.js';

type Flight = { result: Promise<unknown>; controller: AbortController; readers: number };
type Entry = { version: object; expires: number; value?: unknown; flight?: Flight };
const maxEntries = 16, maxAge = 30_000;
const keyFor = (path: string) => path.replace(/\?$/, '');
const aborted = () => new DOMException('Read cancelled', 'AbortError');

// Cancel the transport only when the last interested view leaves.
function consume<T>(flight: Flight, signal?: AbortSignal): Promise<T> {
  flight.readers++;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true; flight.readers--; signal?.removeEventListener('abort', cancel);
      return true;
    };
    const cancel = () => {
      if (!finish()) return;
      if (!flight.readers) flight.controller.abort();
      reject(aborted());
    };
    signal?.addEventListener('abort', cancel, { once: true });
    flight.result.then(value => { if (finish()) resolve(value as T); }, error => { if (finish()) reject(error); });
  });
}

export class WorkspaceQueryCache {
  private entries = new Map<string, Entry>();
  constructor(readonly workspace: string) {}

  peek<T>(path: string): T | undefined {
    const entry = this.entries.get(keyFor(path));
    if (entry && entry.version === workspaceReadVersion(this.workspace) && entry.expires > Date.now()) return entry.value as T;
  }

  read<T>(path: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(aborted());
    const version = workspaceReadVersion(this.workspace);
    if (!version) return request<T>(path, undefined, undefined, undefined, signal);
    const key = keyFor(path), existing = this.entries.get(key);
    if (existing?.version === version) {
      if (existing.flight && !existing.flight.controller.signal.aborted) return consume<T>(existing.flight, signal);
      if (existing.expires > Date.now()) return Promise.resolve(existing.value as T);
    }

    const entry: Entry = { version, expires: 0 };
    this.entries.delete(key);
    if (this.entries.size >= maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, entry);
    const controller = new AbortController();
    const result = request<T>(path, undefined, undefined, undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        entry.value = value; entry.expires = Date.now() + maxAge;
      }
      return value;
    }).finally(() => {
      entry.flight = undefined;
      if (!entry.expires && this.entries.get(key) === entry) this.entries.delete(key);
    });
    entry.flight = { controller, readers: 0, result };
    return consume<T>(entry.flight, signal);
  }

  invalidate(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}

const Context = createContext<WorkspaceQueryCache | undefined>(undefined);
export function WorkspaceQueryProvider({ workspace, viewer, children }: { workspace: string; viewer: string; children: ReactNode }) {
  const cache = useMemo(() => new WorkspaceQueryCache(workspace), [workspace, viewer]);
  return <Context.Provider value={cache}>{children}</Context.Provider>;
}
export function useWorkspaceQueryCache(workspace: string) {
  const cache = useContext(Context);
  return cache?.workspace === workspace ? cache : undefined;
}
export function readWorkspaceQuery<T>(cache: WorkspaceQueryCache | undefined, path: string, signal?: AbortSignal) {
  return cache ? cache.read<T>(path, signal) : request<T>(path, undefined, undefined, undefined, signal);
}
