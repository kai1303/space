import { useEffect, useMemo, useState } from 'react';
import { BookOpen } from '@phosphor-icons/react';
import { Button } from '@space/ui/primitives';
import { GraphCanvas, type GraphLink, type GraphNode } from '@space/ui/graph';
import type { ChannelSummary, MemoryNode, ThreadMemory } from '@space/contracts';
import { memoryApi } from './memory-api.js';
import { MemoryInspector } from './MemoryInspector.js';
import './memory.css';
import './memory-graph.css';

type Props = { channels: ChannelSummary[]; onOpenChannel: (id: string) => void; loadMore?: () => void; loadingMore?: boolean };
type Layer = { channel: ChannelSummary; threads: MemoryNode[]; more: boolean; failed: boolean };
type Selection = { kind: 'channel'; channel: string } | { kind: 'thread'; channel: string; node: MemoryNode } | { kind: 'session'; channel: string; node: MemoryNode; threadId: string };

// One graph for the whole workspace: each joined channel with its recent threads.
// Bounded: at most MAX_CHANNELS channels, each with its newest page of threads, read CONCURRENCY at a time.
// The page reads once and on Refresh; it does not hold a live subscription per channel.
export const MAX_CHANNELS = 25;
const CONCURRENCY = 4;
const palette = { channel: 'var(--sp-accent)', thread: 'var(--sp-success)', session: 'var(--sp-info)' };
const key = (kind: string, id: string) => `${kind}:${id}`;
const failure = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message.replaceAll('_', ' ') : fallback;
const noop = () => {};

export function WorkspaceMemory({ channels, onOpenChannel, loadMore, loadingMore }: Props) {
  const joined = useMemo(() => channels.filter(channel => channel.joined).slice(0, MAX_CHANNELS), [channels]);
  const ids = joined.map(channel => channel.id).join(',');
  const [layers, setLayers] = useState<Layer[]>(), [version, setVersion] = useState(0);
  const [expanded, setExpanded] = useState(new Map<string, ThreadMemory>());
  const [hidden, setHidden] = useState(new Set<string>()), [selected, setSelected] = useState<string>(), [error, setError] = useState('');

  useEffect(() => {
    if (!joined.length) { setLayers([]); return; }
    const controller = new AbortController(), queue = [...joined], read = new Map<string, Layer>();
    async function worker() {
      for (let channel = queue.shift(); channel; channel = queue.shift()) {
        try {
          const page = await memoryApi.layers(channel.id, undefined, controller.signal);
          read.set(channel.id, { channel, threads: page.nodes, more: page.next_cursor !== null, failed: false });
        } catch {
          if (controller.signal.aborted) return;
          read.set(channel.id, { channel, threads: [], more: false, failed: true });
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).then(() => {
      if (!controller.signal.aborted) setLayers(joined.map(channel => read.get(channel.id)!).filter(Boolean));
    });
    return () => controller.abort();
    // `ids` names the joined channels, so a reloaded but unchanged channel list does not re-read memory.
  }, [ids, version]);

  const { nodes, links, lookup } = useMemo(() => {
    const nodes: GraphNode[] = [], links: GraphLink[] = [], lookup = new Map<string, Selection>();
    for (const layer of layers ?? []) {
      const channelId = key('channel', layer.channel.id);
      nodes.push({ id: channelId, kind: 'channel', caption: `#${layer.channel.name}` });
      lookup.set(channelId, { kind: 'channel', channel: layer.channel.id });
      for (const thread of layer.threads) {
        const id = key('thread', thread.ref.id);
        if (hidden.has(id)) continue;
        nodes.push({ id, kind: 'thread', caption: thread.summary || 'Untitled thread' });
        links.push({ id: `has:${thread.ref.id}`, source: channelId, target: id, label: 'HAS' });
        lookup.set(id, { kind: 'thread', channel: layer.channel.id, node: thread });
        for (const session of expanded.get(thread.ref.id)?.sessions ?? []) {
          const sid = key('session', session.ref.id);
          if (hidden.has(sid)) continue;
          nodes.push({ id: sid, kind: 'session', caption: session.agent ?? session.title ?? 'Agent', muted: session.state === 'ended' });
          links.push({ id: `session:${session.ref.id}`, source: id, target: sid, label: 'HAS_SESSION' });
          lookup.set(sid, { kind: 'session', channel: layer.channel.id, node: session, threadId: thread.ref.id });
        }
      }
    }
    return { nodes, links, lookup };
  }, [layers, expanded, hidden]);
  const expandedIds = useMemo(() => new Set([...expanded.keys()].map(id => key('thread', id))), [expanded]);

  async function toggle(id: string) {
    const item = lookup.get(id);
    if (item?.kind !== 'thread') return;
    const thread = item.node.ref.id;
    if (expanded.has(thread)) { setExpanded(old => { const next = new Map(old); next.delete(thread); return next; }); return; }
    try {
      const detail = await memoryApi.thread(item.channel, thread);
      setExpanded(old => new Map(old).set(thread, detail)); setError('');
    } catch (reason) { setError(failure(reason, 'Could not expand')); }
  }
  const selection = selected ? lookup.get(selected) : undefined;
  const menu = (id: string) => {
    const item = lookup.get(id);
    if (!item) return [];
    const open = { label: 'Open channel', icon: 'open', onClick: () => onOpenChannel(item.channel) };
    if (item.kind === 'channel') return [open];
    const hide = { label: 'Hide', icon: 'dismiss', onClick: () => { setHidden(old => new Set(old).add(id)); setSelected(undefined); } };
    if (item.kind === 'thread') return [{ label: expanded.has(item.node.ref.id) ? 'Collapse' : 'Expand', icon: expanded.has(item.node.ref.id) ? 'collapse' : 'expand', onClick: () => void toggle(id) }, open, hide];
    return [open, hide];
  };
  const layerFor = (channel: string) => layers?.find(layer => layer.channel.id === channel);
  const details = !selection ? <aside className="memory-inspector" aria-label="Memory details"><p>Select a node to see its memory.</p></aside>
    : selection.kind === 'channel' ? <ChannelDetails layer={layerFor(selection.channel)} onOpen={() => onOpenChannel(selection.channel)} />
    : <MemoryInspector channel={selection.channel} canManage={false} onDirtyChange={noop}
      selection={selection.kind === 'thread' ? { kind: 'thread', node: selection.node } : { kind: 'session', node: selection.node, threadId: selection.threadId }} />;

  if (!joined.length) return <section className="wd-empty workspace-memory-empty"><span className="wd-empty-icon"><BookOpen size={32} /></span>
    <h2>No channel memory to show</h2><p>Join a channel to see what its agents and members remember.</p>
    {loadMore && <Button loading={loadingMore} onClick={loadMore}>Load more channels</Button>}</section>;
  const threads = layers?.reduce((sum, layer) => sum + layer.threads.length, 0) ?? 0;
  return <section className="workspace-memory memory-graph-view" aria-label="Workspace memory">
    <div className="workspace-memory-toolbar">
      <p role="status">{!layers ? 'Loading workspace memory…' : `${layers.length} ${layers.length === 1 ? 'channel' : 'channels'} · ${threads} ${threads === 1 ? 'thread' : 'threads'} from the last 7 days`}</p>
      <Button size="sm" onClick={() => { setLayers(undefined); setExpanded(new Map()); setSelected(undefined); setVersion(v => v + 1); }}>Refresh</Button>
      {loadMore && joined.length < MAX_CHANNELS && <Button size="sm" loading={loadingMore} onClick={loadMore}>Load more channels</Button>}
      {hidden.size > 0 && <Button size="sm" variant="ghost" onClick={() => setHidden(new Set())}>Show hidden ({hidden.size})</Button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {layers && <div className="memory-graph"><GraphCanvas label="Workspace memory graph" nodes={nodes} links={links} palette={palette}
      selectedId={selected} expandedIds={expandedIds} onSelect={setSelected} onToggleExpand={id => void toggle(id)} menu={menu} details={details} /></div>}
    {layers?.some(layer => layer.more) && <small>Busy channels show their newest 20 threads. Open a channel’s Memory tab to see more.</small>}
    {joined.length === MAX_CHANNELS && <small>Showing the first {MAX_CHANNELS} channels you joined.</small>}
  </section>;
}

function ChannelDetails({ layer, onOpen }: { layer?: Layer; onOpen: () => void }) {
  return <aside className="memory-inspector" aria-label="Memory details">
    <h3>#{layer?.channel.name}</h3>
    <p>{layer?.failed ? 'Memory for this channel could not be loaded.' : `${layer?.threads.length ?? 0} threads with memory in the last 7 days.`}</p>
    <small>Double-click a thread to see its agent sessions. Edit memory from the channel’s Memory tab.</small>
    <Button size="sm" onClick={onOpen}>Open channel</Button>
  </aside>;
}
