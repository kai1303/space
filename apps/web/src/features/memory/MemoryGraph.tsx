import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@space/ui/primitives';
import { GraphCanvas, type GraphLink, type GraphNode } from '@space/ui/graph';
import type { MemoryNode, ThreadMemory } from '@space/contracts';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { memoryApi } from './memory-api.js';

export type MemorySelection = { kind: 'channel' } | { kind: 'thread'; node: MemoryNode } | { kind: 'session'; node: MemoryNode; threadId: string };
type Props = {
  channel: string; name: string;
  onSelect(selection: MemorySelection | undefined): void;
  onAccessLost(): void;
  onOpenThread?(threadId: string): void;
  onOpenSession?(threadId: string, sessionId: string): void;
  // Shown in the graph's in-canvas details panel, like Neo4j's inspector.
  details?: ReactNode;
};
// Space semantic colours: aubergine channel, green thread, blue agent session.
const palette = { channel: 'var(--sp-accent)', thread: 'var(--sp-success)', session: 'var(--sp-info)' };
const key = (kind: string, id: string) => `${kind}:${id}`;
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message.replaceAll('_', ' ') : fallback;

export function MemoryGraph({ channel, name, onSelect, onAccessLost, onOpenThread, onOpenSession, details }: Props) {
  const [threads, setThreads] = useState<MemoryNode[]>([]);
  const [pages, setPages] = useState(1), [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(new Map<string, ThreadMemory>());
  const [hidden, setHidden] = useState(new Set<string>());
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [more, setMore] = useState(false);
  const generation = useRef(0), state = useRef({ pages, expanded });
  state.current = { pages, expanded };
  const lost = useRef(onAccessLost); lost.current = onAccessLost;

  // A refresh re-reads from the start (cursors are snapshots), the same number of pages, and every expanded thread.
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      let after: string | undefined, next: string | null = null;
      const all: MemoryNode[] = [];
      for (let page = 0; page < state.current.pages; page++) {
        const result = await memoryApi.layers(channel, after);
        all.push(...result.nodes); next = result.next_cursor;
        if (!next) break;
        after = next;
      }
      const reloaded = new Map<string, ThreadMemory>();
      for (const id of state.current.expanded.keys()) reloaded.set(id, await memoryApi.thread(channel, id));
      if (version !== generation.current) return;
      setThreads(all); setCursor(next); setExpanded(reloaded); setError(''); setLoaded(true);
    } catch (reason) {
      if (version !== generation.current) return;
      const code = reason instanceof Error ? reason.message : '';
      if (code === 'not_found' || code === 'unauthorized') lost.current();
      else setError(message(reason, 'Memory unavailable'));
      setLoaded(true);
    }
  }, [channel]);

  useEffect(() => {
    void refresh();
    const stop = subscribeUpdates('channel', channel, refresh, () => lost.current());
    return () => { generation.current++; stop(); };
  }, [channel, refresh]);

  async function loadMore() {
    if (!cursor || more) return;
    setMore(true);
    try {
      const result = await memoryApi.layers(channel, cursor);
      setThreads(old => { const seen = new Set(old.map(n => n.ref.id)); return [...old, ...result.nodes.filter(n => !seen.has(n.ref.id))]; });
      setCursor(result.next_cursor); setPages(p => p + 1);
    } catch (reason) { setError(message(reason, 'Could not load more')); }
    finally { setMore(false); }
  }
  async function toggle(id: string) {
    const [kind, ref] = id.split(':') as [string, string];
    if (kind !== 'thread') return;
    if (state.current.expanded.has(ref)) { setExpanded(old => { const next = new Map(old); next.delete(ref); return next; }); return; }
    try {
      const detail = await memoryApi.thread(channel, ref);
      setExpanded(old => new Map(old).set(ref, detail));
    } catch (reason) { setError(message(reason, 'Could not expand')); }
  }

  const { nodes, links, lookup } = useMemo(() => {
    const channelId = key('channel', channel);
    const nodes: GraphNode[] = [{ id: channelId, kind: 'channel', caption: `#${name}` }];
    const links: GraphLink[] = [];
    const lookup = new Map<string, MemorySelection>([[channelId, { kind: 'channel' }]]);
    for (const t of threads) {
      const id = key('thread', t.ref.id);
      if (hidden.has(id)) continue;
      nodes.push({ id, kind: 'thread', caption: t.summary || 'Untitled thread' });
      links.push({ id: `has:${t.ref.id}`, source: channelId, target: id, label: 'HAS' });
      lookup.set(id, { kind: 'thread', node: t });
      for (const s of expanded.get(t.ref.id)?.sessions ?? []) {
        const sid = key('session', s.ref.id);
        if (hidden.has(sid)) continue;
        nodes.push({ id: sid, kind: 'session', caption: s.agent ?? s.title ?? 'Agent', muted: s.state === 'ended' });
        links.push({ id: `session:${s.ref.id}`, source: id, target: sid, label: 'HAS_SESSION' });
        lookup.set(sid, { kind: 'session', node: s, threadId: t.ref.id });
      }
    }
    return { nodes, links, lookup };
  }, [channel, name, threads, expanded, hidden]);
  const expandedIds = useMemo(() => new Set([...expanded.keys()].map(id => key('thread', id))), [expanded]);

  const select = (id: string | undefined) => { setSelected(id); onSelect(id ? lookup.get(id) : undefined); };
  const menu = (id: string) => {
    const item = lookup.get(id);
    if (!item || item.kind === 'channel') return [];
    const hide = { label: 'Hide', icon: 'dismiss', onClick: () => { setHidden(old => new Set(old).add(id)); select(undefined); } };
    if (item.kind === 'thread') return [
      { label: expanded.has(item.node.ref.id) ? 'Collapse' : 'Expand', icon: expanded.has(item.node.ref.id) ? 'collapse' : 'expand', onClick: () => void toggle(id) },
      ...(onOpenThread ? [{ label: 'Open thread', icon: 'open', onClick: () => onOpenThread(item.node.ref.id) }] : []), hide];
    return [...(onOpenSession ? [{ label: 'Open session', icon: 'open', onClick: () => onOpenSession(item.threadId, item.node.ref.id) }] : []), hide];
  };

  return <div className="memory-graph">
    {error && <p role="alert">{error} <Button size="sm" onClick={() => void refresh()}>Retry</Button></p>}
    {!loaded && <p role="status">Loading memory graph…</p>}
    {loaded && <GraphCanvas label={`Memory graph for #${name}`} nodes={nodes} links={links} palette={palette}
      selectedId={selected} expandedIds={expandedIds} onSelect={select} onToggleExpand={id => void toggle(id)} menu={menu} details={details} />}
    {loaded && !threads.length && !error && <p className="memory-graph-empty">No thread has a checkpoint in the last 7 days.</p>}
    <div className="memory-graph-actions">
      {cursor && <Button size="sm" loading={more} onClick={() => void loadMore()}>Load more threads</Button>}
      {hidden.size > 0 && <Button size="sm" variant="ghost" onClick={() => setHidden(new Set())}>Show hidden ({hidden.size})</Button>}
    </div>
  </div>;
}
