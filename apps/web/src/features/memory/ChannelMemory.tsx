import { sessionFetch } from '../../shared/api/session-fetch.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Select, Badge, Button, Dialog, Tabs, toast } from '@space/ui/primitives';
import { Reveal } from '@space/ui/motion';
import { MAX_MEMORY_CHARS, MAX_MEMORY_IMPORT_BYTES, type ChannelMemory as MemoryState, type MemoryDocument, type MemoryMatch } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import './memory.css';
import './memory-graph.css';
import { MemoryConnections } from './MemoryConnections.js';
import { MemoryGraph, type MemorySelection } from './MemoryGraph.js';
import { MemoryInspector } from './MemoryInspector.js';

type Props = { channel: string; name: string; open: boolean; message?: { id: string; text: string }; onClose: () => void;
  onOpenThread?: (threadId: string) => void; onOpenSession?: (threadId: string, sessionId: string) => void };
export function ChannelMemory(props: Props) {
  return props.open ? <MemoryDialog key={props.channel} {...props} /> : null;
}
function MemoryDialog({ channel, name, message, onClose, onOpenThread, onOpenSession }: Props) {
  const [data, setData] = useState<MemoryState>(), [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [provider, setProvider] = useState('markdown'), [conflict, setConflict] = useState(false), [comparison, setComparison] = useState(false);
  const [query, setQuery] = useState(''), [matches, setMatches] = useState<MemoryMatch[] | null>(null);
  const [upload, setUpload] = useState<{ source_id: string; name: string; content: string }>(), [messageSaved, setMessageSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Saving a message is a Notes action, so that entry opens on Notes.
  const [view, setView] = useState<'graph' | 'notes'>(message ? 'notes' : 'graph');
  const [selection, setSelection] = useState<MemorySelection>(), [graphDirty, setGraphDirty] = useState(false);
  const active = useRef(false), pending = useRef(false), generation = useRef(0);
  const path = `/channels/${channel}/memory`, dirty = data?.document != null && draft !== data.document.content;
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  function failure(e: unknown) {
    const code = e instanceof Error ? e.message : 'Unable to update memory';
    if (['unauthorized', 'not_found', 'memory_disabled'].includes(code)) {
      setData(undefined); setDraft(''); setUpload(undefined); setMatches(null); setComparison(false); setConflict(false);
    }
    if (code === 'memory_conflict') {
      setConflict(true); setError('Memory changed. Your draft is kept. Load the latest version, merge your changes, and save again.');
    } else setError(code.replaceAll('_', ' '));
  }
  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (e) { if (active.current) failure(e); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  function accept(document: MemoryDocument, notice: string) {
    setData(previous => previous ? { ...previous, document } : previous); setDraft(document.content);
    setNotice(notice); setMatches(null); setComparison(false); setConflict(false);
  }
  useEffect(() => {
    active.current = true;
    const version = ++generation.current;
    void request<MemoryState>(path).then(result => {
      if (active.current && generation.current === version) { setData(result); setProvider(result.provider); setDraft(result.document?.content ?? ''); }
    }).catch(e => { if (active.current && generation.current === version) failure(e); });
    return () => { active.current = false; generation.current++; };
  }, [path]);
  async function configure(enabled: boolean) {
    await run(async () => {
      const result = await request<MemoryState>(`${path}/settings`, { enabled, provider });
      if (!active.current) return;
      setData(result); setProvider(result.provider); setDraft(result.document?.content ?? ''); setMatches(null); setUpload(undefined);
      setMessageSaved(false); setConflict(false); setComparison(false); setConfirmDelete(false);
      setNotice(enabled ? 'Memory enabled for this channel.' : 'Memory disabled. Stored memory is retained.');
    });
  }
  async function chooseFile(file: File | undefined) {
    if (!file || pending.current) return;
    await run(async () => {
      if (!/\.(md|txt|markdown)$/i.test(file.name)) throw new Error('Choose a Markdown or text document.');
      if (file.size > MAX_MEMORY_IMPORT_BYTES) throw new Error('Documents must be 100 KB or smaller.');
      const buffer = await file.arrayBuffer();
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (active.current) setUpload({ source_id: crypto.randomUUID(), name: file.name, content });
    });
  }
  function exportMemory() {
    const url = URL.createObjectURL(new Blob([data!.document!.content], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${channel}-memory.md`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const openThread = onOpenThread && ((id: string) => { onClose(); onOpenThread(id); });
  const openSession = onOpenSession && ((thread: string, session: string) => { onClose(); onOpenSession(thread, session); });
  return <Dialog open title={`Memory in #${name}`} description="Shared knowledge for this channel, with links to its sources." onClose={() => {
    if (dirty || graphDirty) toast.success('Unsaved memory edits discarded');
    onClose();
  }} onBeforeClose={() => !(dirty || graphDirty) || window.confirm('Discard your unsaved memory edits?')}>
    <Tabs label="Memory views" value={view} onChange={id => setView(id as 'graph' | 'notes')} items={[
      { id: 'graph', label: 'Graph', panelId: `memory-${channel}-graph` },
      { id: 'notes', label: 'Notes', panelId: `memory-${channel}-notes` },
    ]} />
    {view === 'graph' && <div id={`memory-${channel}-graph`} role="tabpanel" aria-label="Graph" className="memory-graph-view">
      <MemoryGraph channel={channel} name={name} onSelect={setSelection} onAccessLost={onClose} onOpenThread={openThread} onOpenSession={openSession} />
      <MemoryInspector channel={channel} selection={selection} canManage={!!data?.can_manage} onDirtyChange={setGraphDirty} onOpenThread={openThread} onOpenSession={openSession} />
    </div>}
    {view === 'notes' && <div id={`memory-${channel}-notes`} role="tabpanel" aria-label="Notes">
    <div className="channel-memory">
      {error && <div role="alert" className="channel-memory-error">{error}</div>}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <p role="status">Loading channel memory…</p>}
      {!data && error && <Button onClick={() => void run(async () => {
        const result = await request<MemoryState>(path);
        if (active.current) { setData(result); setProvider(result.provider); setDraft(result.document?.content ?? ''); }
      })} loading={busy}>Retry</Button>}
      {data && <>
        <div className="channel-memory-heading"><Badge tone={data.enabled ? 'success' : 'neutral'}>{data.enabled ? 'Memory on' : 'Memory off'}</Badge><span>{data.providers.find(item => item.id === data.provider)?.name ?? data.provider}</span></div>
        {!data.enabled && <div className="channel-memory-empty"><strong>Memory is off for this channel.</strong><p>Enable it to keep shared notes, documents, and selected conversations. Messages are saved only when a member chooses to add them.</p>{!data.can_manage && <p>Ask the channel creator or a workspace administrator to enable memory.</p>}</div>}
        {data.can_manage && <div className="channel-memory-settings">
          <label>Memory provider<Select aria-label="Memory provider" value={provider} disabled={busy || dirty} onChange={event => setProvider(event.target.value)}>
            {!data.providers.some(item => item.id === data.provider) && <option value={data.provider}>{data.provider} (unavailable)</option>}
            {data.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select></label>
          <div className="channel-memory-actions">
            {!data.enabled ? <Button variant="primary" loading={busy} onClick={() => void configure(true)}>Enable memory</Button>
              : <><Button disabled={busy || dirty} onClick={() => void configure(false)}>Disable memory</Button>{provider !== data.provider && <Button variant="primary" disabled={busy || dirty} onClick={() => void configure(true)}>Use selected provider</Button>}</>}
          </div>
          {provider !== data.provider && <small>Changing providers keeps existing memory in the previous provider. Content is not copied automatically.</small>}
        </div>}
        {data.enabled && data.document && <>
          {message && <section className="channel-memory-selection" aria-label="Selected message"><strong>Save this conversation to memory</strong><blockquote>{message.text || 'Message with attachments'}</blockquote><Button disabled={busy || dirty || messageSaved} onClick={() => void run(async () => {
            const document = await request<MemoryDocument>(`${path}/sources`, { message_id: message.id });
            if (active.current) { accept(document, 'Message saved to memory.'); setMessageSaved(true); }
          })}>{messageSaved ? 'Message saved' : 'Save message to memory'}</Button></section>}
          <form className="channel-memory-editor" onSubmit={(event: FormEvent) => { event.preventDefault(); void run(async () => {
            const document = await request<MemoryDocument>(`${path}/document`, { content: draft, revision: data.document!.revision });
            if (active.current) accept(document, 'Memory saved.');
          }); }}>
            <label>Channel memory Markdown<textarea value={draft} maxLength={MAX_MEMORY_CHARS} disabled={busy} spellCheck={false} onChange={event => setDraft(event.target.value)} placeholder={'# Channel knowledge\n\n## Decisions\n\n## Facts\n\n## Procedures'} /></label>
            <div className="channel-memory-actions"><Button type="submit" variant="primary" loading={busy} disabled={!dirty || conflict}>Save changes</Button><Button disabled={busy} onClick={exportMemory}>Export Markdown</Button><small>{draft.length.toLocaleString()} / {MAX_MEMORY_CHARS.toLocaleString()} characters{dirty ? ' · Unsaved changes' : ''}</small></div>
          </form>
          {conflict && <Button disabled={busy} onClick={() => void run(async () => {
            const result = await request<MemoryState>(path);
            if (active.current) {
              setData(result); setComparison(Boolean(result.enabled)); setConflict(false);
              if (!result.enabled) { setDraft(''); setUpload(undefined); setMatches(null); }
              else setNotice('Latest version loaded below. Merge it into your draft before saving.');
            }
          })}>Load latest for comparison</Button>}
          <Reveal open={comparison}><section className="channel-memory-comparison"><strong>Latest saved memory</strong><pre>{data.document.content}</pre></section></Reveal>
          {dirty && <small>Save your edits before adding or removing sources or changing memory settings.</small>}
          <section className="channel-memory-import" aria-label="Import a document"><strong>Add a document</strong><label>Choose a memory document<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" disabled={busy || dirty} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseFile(file); }} /></label><small>UTF-8 Markdown or text, up to 100 KB.</small>
            {upload && <div className="channel-memory-actions"><span>{upload.name}</span><Button disabled={busy || dirty} onClick={() => void run(async () => {
              const document = await request<MemoryDocument>(`${path}/sources`, upload);
              if (active.current) { accept(document, 'Document added to memory.'); setUpload(undefined); }
            })}>Import document</Button></div>}
          </section>
          {data.document.sources.length > 0 && <section className="channel-memory-sources"><strong>Saved sources</strong><ul>{data.document.sources.map(source => <li key={source.id}><div><span>{source.title}</span>{source.url && <a href={source.url}>View original message</a>}</div><Button size="sm" disabled={busy || dirty} aria-label={`Remove ${source.title}`} onClick={() => void run(async () => {
            const document = await requestDelete<MemoryDocument>(`${path}/sources/${encodeURIComponent(source.id)}`);
            if (active.current) accept(document, 'Source removed from memory.');
          })}>Remove</Button></li>)}</ul></section>}
          <form className="channel-memory-search" onSubmit={event => { event.preventDefault(); void run(async () => {
            const result = await request<{ items: MemoryMatch[] }>(`${path}/search?q=${encodeURIComponent(query)}`);
            if (active.current) setMatches(result.items);
          }); }}><label>Search saved memory<input value={query} maxLength={200} disabled={busy} onChange={event => { setQuery(event.target.value); setMatches(null); }} /></label><Button type="submit" disabled={busy || !query.trim()}>Search memory</Button></form>
          {matches && <div className="channel-memory-matches" role="status">{matches.length ? matches.map(match => <p key={match.line}><small>Line {match.line}</small> {match.text}</p>) : <p>No matching saved memory.</p>}</div>}
        </>}
        {data.can_manage && <MemoryConnections key={channel} channel={channel} enabled={data.enabled} />}
        {data.can_manage && <div className="channel-memory-delete"><Reveal open={confirmDelete}><div className="channel-memory-delete-confirmation"><p>Delete all saved memory in this provider? Conversation messages and uploaded files stay in chat.</p><div className="channel-memory-actions"><Button variant="danger" disabled={busy || dirty} onClick={() => void run(async () => {
          await requestDelete(path);
          if (!active.current) return;
          toast.success('Stored channel memory deleted');
          setConfirmDelete(false); setUpload(undefined); setMatches(null); setMessageSaved(false);
          if (data.enabled) {
            const result = await request<MemoryState>(path);
            if (active.current) { setData(result); setDraft(result.document?.content ?? ''); }
          }
        })}>Confirm delete memory</Button><Button disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</Button></div></div></Reveal>{!confirmDelete && <Button variant="ghost" disabled={busy || dirty} onClick={() => setConfirmDelete(true)}>Delete stored memory…</Button>}</div>}
      </>}
    </div>
    </div>}
  </Dialog>;
}

async function requestDelete<T = unknown>(path: string): Promise<T> {
  const response = await sessionFetch(`/v1${path}`, { method: 'DELETE', credentials: 'same-origin' });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('space:session-expired'));
    throw new Error(result.error ?? 'Request failed');
  }
  return result as T;
}
