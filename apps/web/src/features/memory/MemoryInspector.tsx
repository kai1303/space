import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@space/ui/primitives';
import type { SessionMemory, MemoryRecord, ThreadMemory } from '@space/contracts';
import { memoryApi } from './memory-api.js';
import type { MemorySelection } from './MemoryGraph.js';

type Props = {
  channel: string; selection: MemorySelection | undefined; canManage: boolean;
  onDirtyChange(dirty: boolean): void;
  onOpenThread?(threadId: string): void;
  onOpenSession?(threadId: string, sessionId: string): void;
};
type Detail = { memory: MemoryRecord | null; chars: number; ended: boolean };
const toDetail = (data: ThreadMemory | SessionMemory): Detail => 'context' in data
  ? { memory: data.context.memory, chars: data.memory_chars, ended: false }
  : { memory: data.memory, chars: data.memory_chars, ended: data.node.state === 'ended' };

export function MemoryInspector(props: Props) {
  const { selection } = props;
  if (!selection) return <aside className="memory-inspector" aria-label="Memory details"><p>Select a node to see its memory.</p></aside>;
  if (selection.kind === 'channel') return <aside className="memory-inspector" aria-label="Memory details"><h3>Channel</h3><p>Double-click a thread to see its agent sessions.</p></aside>;
  return <NodeInspector key={`${selection.kind}:${selection.node.ref.id}`} {...props} selection={selection} />;
}

function NodeInspector({ channel, selection, canManage, onDirtyChange, onOpenThread, onOpenSession }: Props & { selection: Exclude<MemorySelection, { kind: 'channel' }> }) {
  const [detail, setDetail] = useState<Detail>(), [error, setError] = useState('');
  const [editing, setEditing] = useState(false), [summary, setSummary] = useState(''), [content, setContent] = useState('');
  const [base, setBase] = useState(0), [newer, setNewer] = useState<MemoryRecord | null>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const dirtyChange = useRef(onDirtyChange); dirtyChange.current = onDirtyChange;
  const id = selection.node.ref.id;
  const read = (signal?: AbortSignal) => selection.kind === 'thread' ? memoryApi.thread(channel, id, signal) : memoryApi.session(channel, id, signal);

  useEffect(() => {
    const controller = new AbortController();
    read(controller.signal).then(data => { if (!controller.signal.aborted) setDetail(toDetail(data)); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Could not load memory'); });
    return () => { controller.abort(); dirtyChange.current(false); };
  }, [channel, id, selection.kind]);

  const dirty = editing && (summary !== (detail?.memory?.summary ?? '') || content !== (detail?.memory?.content ?? ''));
  useEffect(() => { dirtyChange.current(dirty); }, [dirty]);

  function startEdit() {
    setSummary(detail?.memory?.summary ?? selection.node.summary); setContent(detail?.memory?.content ?? '');
    setBase(detail?.memory?.revision ?? 0); setNewer(undefined); setNotice(''); setError(''); setEditing(true);
  }
  // A clash keeps the draft, shows the newer text, and moves the base so the next save can win.
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    const edit = { revision: base, summary, content };
    try {
      const saved = selection.kind === 'thread' ? await memoryApi.saveThread(channel, id, edit) : await memoryApi.saveSession(channel, id, edit);
      setDetail(old => ({ memory: saved, chars: saved.content.length, ended: old?.ended ?? false }));
      setEditing(false); setNewer(undefined); setNotice(`Saved as revision ${saved.revision}.`);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : '';
      if (code.endsWith('_memory_conflict')) {
        const latest = toDetail(await read());
        setNewer(latest.memory); setBase(latest.memory?.revision ?? 0);
        setError('This memory changed while you were editing. Your draft is kept. Compare with the newer text, then save again.');
      } else setError(code.replaceAll('_', ' ') || 'Could not save');
    } finally { setBusy(false); }
  }

  const cp = detail?.memory;
  const title = selection.kind === 'thread' ? selection.node.summary : `${selection.node.agent ?? 'Agent'} · ${selection.node.title ?? ''}`;
  return <aside className="memory-inspector" aria-label="Memory details">
    <h3>{title}</h3>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!detail && !error && <p role="status">Loading…</p>}
    {detail && <>
      <small>{selection.kind}{detail.ended ? ' · ended' : ''}{cp ? ` · rev ${cp.revision} · ${cp.producer_name} · ${cp.created_at}` : ' · no memory yet'}</small>
      <label>Size<meter min={0} max={6000} value={detail.chars} /><small>{detail.chars} / 6000</small></label>
      {!editing && cp && <details open><summary>Memory</summary><pre>{cp.content}</pre></details>}
      {!editing && cp && <details><summary>Sources ({cp.source_message_ids.length})</summary><ul>{cp.source_message_ids.map(m => <li key={m}><code>{m}</code></li>)}</ul></details>}
      {canManage && !detail.ended && !editing && <Button size="sm" onClick={startEdit}>Edit</Button>}
      {editing && <form onSubmit={event => void save(event)}>
        <label>Summary<input aria-label="Summary" value={summary} maxLength={280} required onChange={e => setSummary(e.target.value)} /><small>{summary.length} / 280</small></label>
        <label>Memory<textarea aria-label="Memory" value={content} maxLength={6000} required onChange={e => setContent(e.target.value)} /><small>{content.length} / 6000</small></label>
        {newer && <details open><summary>Newer version (rev {newer.revision})</summary><pre>{newer.content}</pre></details>}
        <div><Button type="submit" size="sm" loading={busy} disabled={!summary.trim() || !content.trim()}>Save memory</Button>{' '}
          <Button type="button" size="sm" variant="ghost" onClick={() => { if (!dirty || window.confirm('Discard your memory edits?')) { setEditing(false); setError(''); setNewer(undefined); } }}>Cancel</Button></div>
      </form>}
      {selection.kind === 'thread' && onOpenThread && <Button size="sm" variant="ghost" onClick={() => onOpenThread(id)}>Open thread →</Button>}
      {selection.kind === 'session' && onOpenSession && <Button size="sm" variant="ghost" onClick={() => onOpenSession(selection.threadId, id)}>Open session →</Button>}
    </>}
  </aside>;
}
