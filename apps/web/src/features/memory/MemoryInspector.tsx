import { useEffect, useState } from 'react';
import { Button } from '@space/ui/primitives';
import type { SessionMemory, ThreadContextMessage, ThreadMemory } from '@space/contracts';
import { memoryApi } from './memory-api.js';
import type { MemorySelection } from './MemoryGraph.js';

type Props = {
  channel: string; selection: MemorySelection | undefined;
  onOpenThread?(threadId: string): void;
  onOpenSession?(threadId: string, sessionId: string): void;
};
type Detail = { messages: ThreadContextMessage[]; related: ThreadContextMessage[]; ended: boolean };
// Memory is built from messages, so the inspector only shows what the conversation holds.
const toDetail = (data: ThreadMemory | SessionMemory): Detail => 'context' in data
  ? { messages: [...(data.context.root && !data.context.messages.some(m => m.id === data.context.root!.id) ? [data.context.root] : []), ...data.context.messages], related: data.related, ended: false }
  : { messages: data.messages, related: data.related, ended: data.node.state === 'ended' };

export function MemoryInspector(props: Props) {
  const { selection } = props;
  if (!selection) return <aside className="memory-inspector" aria-label="Memory details"><p>Select a node to see its memory.</p></aside>;
  if (selection.kind === 'channel') return <aside className="memory-inspector" aria-label="Memory details"><h3>Channel</h3><p>Double-click a thread to see its agent sessions.</p></aside>;
  return <NodeInspector key={`${selection.kind}:${selection.node.ref.id}`} {...props} selection={selection} />;
}

function Messages({ label, messages }: { label: string; messages: ThreadContextMessage[] }) {
  if (!messages.length) return null;
  return <details open><summary>{label} ({messages.length})</summary>
    <ul>{messages.map(m => <li key={m.id}><pre>{m.text}{m.text_truncated ? '…' : ''}</pre></li>)}</ul></details>;
}

function NodeInspector({ channel, selection, onOpenThread, onOpenSession }: Props & { selection: Exclude<MemorySelection, { kind: 'channel' }> }) {
  const [detail, setDetail] = useState<Detail>(), [error, setError] = useState('');
  const id = selection.node.ref.id;
  const read = (signal?: AbortSignal) => selection.kind === 'thread' ? memoryApi.thread(channel, id, signal) : memoryApi.session(channel, id, signal);

  useEffect(() => {
    const controller = new AbortController();
    read(controller.signal).then(data => { if (!controller.signal.aborted) setDetail(toDetail(data)); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Could not load memory'); });
    return () => controller.abort();
  }, [channel, id, selection.kind]);

  const title = selection.kind === 'thread' ? selection.node.summary : `${selection.node.agent ?? 'Agent'} · ${selection.node.title ?? ''}`;
  return <aside className="memory-inspector" aria-label="Memory details">
    <h3>{title}</h3>
    {error && <p role="alert">{error}</p>}
    {!detail && !error && <p role="status">Loading…</p>}
    {detail && <>
      <small>{selection.kind}{detail.ended ? ' · ended' : ''}{selection.node.updated_at ? ` · ${selection.node.updated_at}` : ''}</small>
      <Messages label="Messages" messages={detail.messages} />
      <Messages label="Related" messages={detail.related} />
      {selection.kind === 'thread' && onOpenThread && <Button size="sm" variant="ghost" onClick={() => onOpenThread(id)}>Open thread →</Button>}
      {selection.kind === 'session' && onOpenSession && <Button size="sm" variant="ghost" onClick={() => onOpenSession(selection.threadId, id)}>Open session →</Button>}
    </>}
  </aside>;
}
