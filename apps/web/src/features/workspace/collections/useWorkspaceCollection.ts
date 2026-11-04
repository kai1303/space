import { useEffect, useRef, useState } from 'react';
import type { HubFile, HubMessage, HubTodo, Page } from '@space/contracts';
import { request } from '../../../shared/api/request.js';
import { subscribeUpdates } from '../../../shared/realtime/live-updates.js';
export type CollectionView = 'threads' | 'saved' | 'sent' | 'files' | 'todos';
type Item = HubMessage | HubFile | HubTodo;
const failure = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to load this collection';
const denied = (error: unknown) => error instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(error.message);
const PAGE_SIZE = 24;
export const MAX_ITEMS = 240;

export function useCollection(workspace: string, view: CollectionView, query = '') {
  const [items, setItems] = useState<Item[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false), [writeError, setWriteError] = useState(''), [revoked, setRevoked] = useState(false);
  const controls = useRef({ active: true, revoked: false, revision: 0, writing: false, read: undefined as AbortController | undefined, write: undefined as AbortController | undefined });
  const retryAfter = useRef<string | undefined>(undefined);
  // shortcut: confirmed new rows outside the loaded range await pagination; use targeted GETs for cross-client detail refresh.
  const loadedPages = useRef(1), confirmedTodos = useRef(new Map<string, HubTodo>());
  const base = `/workspaces/${encodeURIComponent(workspace)}/hub`;
  async function load(after?: string) {
    const state = controls.current;
    if (!state.active || state.revoked || state.writing) return;
    state.read?.abort(); const controller = new AbortController(); state.read = controller;
    const revision = ++state.revision; retryAfter.current = after; setLoading(true); setError('');
    try {
      const pageCount = (view === 'todos' || view === 'files') && !after ? loadedPages.current : 1;
      const incoming: Item[] = []; let next = after, pagesRead = 0;
      do {
        const params = new URLSearchParams(query); params.set('limit', String(PAGE_SIZE)); if (next) params.set('after', next);
        const page = await request<Page<Item>>(`${base}/${view}?${params}`, undefined, undefined, 'POST', controller.signal);
        if (!Array.isArray(page.items)) throw new Error('Invalid collection response');
        if (!state.active || controller.signal.aborted || revision !== state.revision) return;
        incoming.push(...page.items); next = page.next_cursor ?? undefined; pagesRead++;
      } while (next && pagesRead < pageCount);
      if (view === 'todos' || view === 'files') {
        loadedPages.current = Math.min(MAX_ITEMS / PAGE_SIZE, after ? loadedPages.current + 1 : pagesRead);
        for (const item of incoming) confirmedTodos.current.delete(item.id);
      }
      setItems(previous => {
        const confirmed = [...confirmedTodos.current.values()];
        const merged = [...new Map([...(after ? previous : []), ...incoming].map(item => [item.id, item])).values()];
        return [...merged.filter(item => !confirmedTodos.current.has(item.id)).slice(0, MAX_ITEMS - confirmed.length), ...confirmed];
      });
      setCursor(next ?? null);
    } catch (reason) {
      if (!state.active || controller.signal.aborted || revision !== state.revision) return;
      if (denied(reason)) { confirmedTodos.current.clear(); loadedPages.current = 1; setItems([]); setCursor(null); }
      setError(failure(reason));
    } finally { if (state.active && revision === state.revision) setLoading(false); }
  }
  useEffect(() => {
    const state = controls.current; state.active = true;
    const stop = subscribeUpdates('workspace', workspace, () => load(), code => {
      state.revoked = true; confirmedTodos.current.clear(); setRevoked(true); state.revision++; state.read?.abort(); state.write?.abort();
      setItems([]); setCursor(null); setLoading(false); setBusy(false); setWriteError(''); setError(failure(new Error(code)));
    });
    return () => { state.active = false; state.revision++; state.read?.abort(); state.write?.abort(); stop(); };
  }, [workspace, view, query]);
  async function change<T>(path: string, body: object): Promise<T | undefined> {
    const state = controls.current;
    if (state.writing || state.revoked || !state.active) return;
    state.writing = true; state.revision++; state.read?.abort(); setLoading(false); setBusy(true); setWriteError('');
    const controller = new AbortController(); state.write = controller;
    try {
      const value = await request<T>(`${base}${path}`, body, undefined, 'POST', controller.signal);
      if (!state.active || state.revoked || controller.signal.aborted) return;
      if (view === 'todos') {
        const todo = value as HubTodo;
        confirmedTodos.current.delete(todo.id); confirmedTodos.current.set(todo.id, todo);
        if (confirmedTodos.current.size > MAX_ITEMS) confirmedTodos.current.delete(confirmedTodos.current.keys().next().value!);
        setItems(previous => [...previous.filter(item => item.id !== todo.id).slice(-(MAX_ITEMS - 1)), todo]);
      }
      state.writing = false;
      await load();
      return value;
    } catch (reason) {
      if (state.active && !controller.signal.aborted) {
        if (denied(reason)) { confirmedTodos.current.clear(); loadedPages.current = 1; setItems([]); setCursor(null); }
        setWriteError(failure(reason));
      }
    } finally { state.writing = false; if (state.active) setBusy(false); }
  }
  return { items, cursor, loading, error, busy, writeError, revoked, change, clearAndRefresh: () => { setItems([]); setCursor(null); return load(); }, more: () => load(cursor ?? undefined), retry: () => load(retryAfter.current) };
}
