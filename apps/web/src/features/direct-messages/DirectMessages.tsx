import {useDestinationPresence} from '../../shared/ui/useDestinationPresence.js';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import type { ChannelMember, ChannelUnread, DirectMessageSummary, Page } from '@space/contracts';
import { Avatar, Button, IconButton } from '@space/ui/primitives';
import { ChatCircle, MagnifyingGlass, PencilSimple } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { useWorkspaceUnread } from '../notifications/useWorkspaceUnread.js';
import { ConversationComposer, ConversationHeader } from '../chat/ThreadConversation.js';
import type { RichDocument } from '@space/ui/rich-text';
import type { DirectView } from './view-state.js';
import type { Snapshot } from '../../shared/ui/view-state.js';
import './direct-messages.css';
const errorText = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to load direct messages';
const denied = (error: unknown) => error instanceof Error && ['not_found', 'unauthorized', 'forbidden'].includes(error.message);
function useDebouncedValue(value: string) {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), 180); return () => clearTimeout(timer); }, [value]);
  return settled;
}

export function useDirectMessageList(workspace: string, query = '', after = '', unreadOnly = false) {
  const key = `${workspace}:${query}:${after}:${unreadOnly}`;
  const [state, setState] = useState({ key, items: [] as DirectMessageSummary[], next: null as string | null, loaded: false, error: '' });
  const readRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true, generation = 0;
    let controller: AbortController | undefined;
    const read = async () => {
      const attempt = ++generation; controller?.abort(); controller = new AbortController();
      try {
        const params = new URLSearchParams({ limit: '50', ...(query ? { q: query } : {}), ...(after ? { after } : {}), ...(unreadOnly ? { unread: 'true' } : {}) });
        const page = await request<Page<DirectMessageSummary>>(`/workspaces/${workspace}/direct-messages?${params}`, undefined, undefined, 'POST', controller.signal);
        if (active && attempt === generation) setState({ key, items: page.items ?? [], next: page.next_cursor ?? null, loaded: true, error: '' });
      } catch (error) {
        if (active && attempt === generation && !(error instanceof Error && error.name === 'AbortError')) {
          setState(old => ({ ...(old.key === key && !denied(error) ? old : { key, items: [], next: null }), loaded: true, error: errorText(error) }));
        }
      }
    };
    readRef.current = read;
    const stop = subscribeUpdates('workspace', workspace, read, code => {
      generation++; controller?.abort(); setState({ key, items: [], next: null, loaded: true, error: errorText(new Error(code)) });
    });
    return () => { active = false; generation++; controller?.abort(); stop(); };
  }, [workspace, query, after, unreadOnly]);
  return { ...(state.key === key ? state : { items: [], next: null, loaded: false, error: '' }), refresh: () => readRef.current() };
}

export function NewDirectMessage({ workspace, viewer, defaultValue, onDraftChange, onOpen, onClose }: { workspace: string; viewer: string; defaultValue?: RichDocument; onDraftChange?: (document: RichDocument) => void; onOpen: (dm: DirectMessageSummary, document: RichDocument) => void; onClose: () => void }) {
  const draft = useRef<RichDocument>(defaultValue ?? { ops: [] });
  const present=useDestinationPresence();
  const [query, setQuery] = useState(''), search = useDebouncedValue(query);
  const [people, setPeople] = useState<ChannelMember[]>([]), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const active = useRef(true), opening = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let current = true; const controller = new AbortController(); setLoaded(false); setError('');
    void request<Page<ChannelMember>>(`/workspaces/${workspace}/direct-message-people?${new URLSearchParams({ q: search, limit: '30' })}`, undefined, undefined, 'POST', controller.signal)
      .then(page => { if (current) { setPeople(page.items ?? []); setLoaded(true); } })
      .catch(reason => { if (current && reason?.name !== 'AbortError') { setError(errorText(reason)); setLoaded(true); } });
    return () => { current = false; controller.abort(); };
  }, [workspace, search, retry]);
  async function open(person: ChannelMember) {
    if (opening.current) return; opening.current = true; setBusy(true); setError('');
    try {
      const dm = await request<DirectMessageSummary>(`/workspaces/${workspace}/direct-messages`, { user_id: person.id });
      if (active.current && present.current) onOpen(dm, draft.current);
    } catch (reason) { if (active.current) setError(errorText(reason)); }
    finally { opening.current = false; if (active.current) setBusy(false); }
  }
  const searching = !loaded || search !== query;
  return <main id="chat-messages" className="dm-new-message" tabIndex={-1}><ConversationHeader title="New message" onClose={onClose} /><div className="dm-recipient-picker">
    <div className="dm-recipient-search"><MagnifyingGlass size={18} /><label htmlFor="dm-recipient">To</label><input id="dm-recipient" type="search" autoFocus maxLength={100} placeholder="Find a person…" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></div>
    {error && <div role="alert" className="dm-error">{error}<Button size="sm" onClick={() => setRetry(value => value + 1)}>Retry</Button></div>}
    {searching ? <p role="status">Finding people…</p> : <ul className="dm-people" aria-label="People">{people.map(person => <li key={person.id}><button disabled={busy} onClick={() => void open(person)}><Avatar name={person.name} initials={person.name.slice(0, 2).toUpperCase()} image={person.image} presence={person.presence === 'active' ? 'online' : 'away'} /><span><strong>{person.name}{person.id === viewer ? ' (you)' : ''}</strong><small>{person.id === viewer ? 'Your personal space' : person.title || 'Workspace member'}</small></span></button></li>)}</ul>}
    {!searching && !error && !people.length && <p>No people found. Try another name.</p>}
    {!searching && people.length === 30 && <p className="dm-hint">Showing the first 30 matches. Type a name to narrow your search.</p>}
    {busy && <p role="status">Opening conversation…</p>}
  </div><ConversationComposer channel="new conversation" placeholder="Write a message…" defaultValue={defaultValue} onDraftChange={document => { draft.current = document; onDraftChange?.(document); }} attachmentsEnabled={false} showUnavailableActions={false} sendDisabledReason="Choose a recipient before sending." onSend={() => {}} /></main>;
}

type RoomControls = { close: () => Promise<void>; change: (dm: DirectMessageSummary) => void; readState?: ChannelUnread };
export function DirectMessages({ workspace, viewer, requestedId, compose = 0, width = 350, onVisit, onSearchAvailabilityChange, viewState, drafts = {}, onDraftChange, renderConversation }: {
  workspace: string; viewer: string; requestedId?: string; compose?: number; width?: number;
  viewState?: Snapshot<DirectView>; drafts?: Record<string, RichDocument>; onDraftChange?: (key: string, document: RichDocument) => void;
  onVisit: (dm?: DirectMessageSummary) => void; onSearchAvailabilityChange?: (available: boolean) => void;
  renderConversation: (dm: DirectMessageSummary, controls: RoomControls) => ReactNode;
}) {
  const localView=useRef<DirectView>({query:'',unreads:false,after:'',scroll:0}),view=viewState??localView,sidebar=useRef<HTMLElement>(null);
  const [query, setQuery] = useState(view.current.query), search = useDebouncedValue(query), [after, setAfter] = useState(view.current.after);
  const [unreads, setUnreads] = useState(view.current.unreads), [selected, setSelected] = useState<DirectMessageSummary>();
  const [newOpen, setNewOpen] = useState(Boolean(compose)), [error, setError] = useState('');
  const [mobileConversation, setMobileConversation] = useState(false);
  useLayoutEffect(()=>{view.current={...view.current,query,after,unreads};},[view,query,after,unreads]);
  const composeKey = `new-direct:${workspace}`, localDraft = useRef<RichDocument>(drafts[composeKey] ?? { ops: [] });
  function saveNewDraft(document: RichDocument) { localDraft.current = document; onDraftChange?.(composeKey, document); }
  function cancelNewMessage() {
    setNewOpen(false); setMobileConversation(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#chat-conversations button[aria-label="New message"]')?.focus());
  }
  function openNewMessage(dm: DirectMessageSummary, document: RichDocument) {
    if (document.ops.some(op => op.insert.trim())) {
      const existing = drafts[dm.id];
      onDraftChange?.(dm.id, existing?.ops.some(op => op.insert.trim()) ? { ops: [...existing.ops, { insert: '\n' }, ...document.ops] } : document);
    }
    saveNewDraft({ ops: [] }); choose(dm, true); setQuery(''); setAfter(''); setUnreads(false); void list.refresh();
  }
  const list = useDirectMessageList(workspace, search, after, unreads), unread = useWorkspaceUnread(workspace);
  useLayoutEffect(()=>{if(list.loaded&&sidebar.current)sidebar.current.scrollTop=view.current.scroll;},[list.loaded,view]);
  const active = useRef(true), selectedId = useRef<string | undefined>(undefined); selectedId.current = selected?.id;
  const visit = useRef(onVisit); visit.current = onVisit;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (compose) setNewOpen(true); }, [compose]);
  useEffect(() => { onSearchAvailabilityChange?.(!!selected && !newOpen); return () => onSearchAvailabilityChange?.(false); }, [selected?.id, newOpen, onSearchAvailabilityChange]);
  function choose(dm: DirectMessageSummary, focusComposer = false) { selectedId.current = dm.id; setSelected(dm); setError(''); setNewOpen(false); setMobileConversation(true); visit.current(dm); requestAnimationFrame(() => (focusComposer ? document.querySelector<HTMLElement>('#chat-messages .ql-editor[contenteditable=true]') ?? document.querySelector<HTMLElement>('#chat-messages') : document.querySelector<HTMLElement>('#chat-messages'))?.focus()); }
  useEffect(() => {
    if (!requestedId || requestedId === selectedId.current) return;
    let current = true;
    void request<DirectMessageSummary>(`/channels/${requestedId}`).then(dm => {
      if (current && dm.kind === 'direct') choose(dm);
    }).catch(reason => { if (current) setError(errorText(reason)); });
    return () => { current = false; };
  }, [requestedId]);
  // Authorization and profile changes are rechecked even when the selected DM is off the current inbox page.
  useEffect(() => {
    if (!selected?.id) return;
    const id = selected.id; let current = true;
    const revoke = (reason: unknown) => { if (current) { setSelected(undefined); setMobileConversation(false); setError(errorText(reason)); visit.current(undefined); } };
    return (() => {
      const stop = subscribeUpdates('channel', id, async () => {
        try {
          const dm = await request<DirectMessageSummary>(`/channels/${id}`);
          if (current && selectedId.current === id && dm.kind === 'direct') setSelected(dm);
        } catch (reason) { if (denied(reason)) revoke(reason); else if (current) setError(errorText(reason)); }
      }, code => revoke(new Error(code)));
      return () => { current = false; stop(); };
    })();
  }, [selected?.id]);
  async function close() {
    if (!selected) return; const id = selected.id;
    try {
      await request(`/channels/${id}/direct-message`, { hidden: true }, undefined, 'PATCH');
      if (!active.current) return;
      if (selectedId.current === id) { selectedId.current = undefined; setSelected(undefined); setMobileConversation(false); visit.current(undefined); }
      await list.refresh();
    } catch (reason) { if (active.current) setError(errorText(reason)); }
  }
  const items = list.items.filter(dm => !unreads || (unread.channels.find(item => item.channel_id === dm.id)?.unread_count ?? 0) > 0);
  return <div className={`chat-layout dm-layout${newOpen || (mobileConversation && selected) ? ' dm-layout--conversation' : ''}`} style={{ '--chat-sidebar-width': `${width}px` } as CSSProperties}>
    <aside ref={sidebar} onScroll={event=>{view.current.scroll=event.currentTarget.scrollTop;}} id="chat-conversations" className="chat-sidebar dm-inbox" aria-label="Direct messages">
      <header className="dm-heading"><h2>Direct messages</h2><label className="dm-unreads">Unreads<input type="checkbox" role="switch" checked={unreads} onChange={event => { setUnreads(event.target.checked); setAfter(''); }} /></label><IconButton label="New message" onClick={() => setNewOpen(true)}><PencilSimple size={20} /></IconButton></header>
      <div className="dm-filter"><MagnifyingGlass size={17} /><input type="search" aria-label="Find a DM" placeholder="Find a DM…" maxLength={100} value={query} onChange={event => { setQuery(event.target.value); setAfter(''); }} /></div>
      {list.error && <div role="alert" className="dm-error">{list.error}<Button size="sm" onClick={() => void list.refresh()}>Retry</Button></div>}
      {!list.loaded || search !== query ? <p role="status">Loading direct messages…</p> : <ul className="dm-list">{items.map(dm => {
        const count = unread.channels.find(item => item.channel_id === dm.id)?.unread_count ?? 0;
        return <li key={dm.id}><button className={`dm-row${!newOpen && dm.id === selected?.id ? ' is-selected' : ''}${count ? ' is-unread' : ''}`} aria-label={`Open DM with ${dm.name}${count ? `, ${count} unread` : ''}`} aria-current={!newOpen && dm.id === selected?.id ? 'true' : undefined} onClick={() => choose(dm)}>
          <Avatar name={dm.name} initials={dm.name.slice(0, 2).toUpperCase()} image={(dm.participants.find(person => person.id !== viewer) ?? dm.participants[0])?.image} presence={(dm.participants.find(person => person.id !== viewer) ?? dm.participants[0])?.presence === 'active' ? 'online' : 'away'} /><span className="dm-row-body"><strong>{dm.name}</strong><span>{dm.last_message?.text || (dm.last_message ? 'Shared a file' : dm.participants.length === 1 ? 'Notes, links, and files just for you' : 'Start a conversation')}</span></span>{count > 0 && <span className="dm-count">{count > 99 ? '99+' : count}</span>}
        </button></li>;
      })}</ul>}
      {list.loaded && !items.length && !list.error && <p className="dm-hint">{unreads ? 'No unread conversations.' : query ? 'No matching conversations.' : 'Your direct messages will appear here.'}</p>}
      <div className="dm-pages">{after && <Button size="sm" onClick={() => setAfter('')}>Back to newest</Button>}{list.next && <Button size="sm" onClick={() => setAfter(list.next!)}>More conversations</Button>}</div>
    </aside>
    <div className="dm-room">{(selected || newOpen) && <button className="dm-back" onClick={cancelNewMessage}>← All direct messages</button>}{error && <p role="alert" className="dm-error">{error}</p>}
      {newOpen ? <NewDirectMessage workspace={workspace} viewer={viewer} defaultValue={localDraft.current} onDraftChange={saveNewDraft} onClose={cancelNewMessage} onOpen={openNewMessage} /> : selected ? renderConversation(selected, { close, change: setSelected, readState: unread.channels.find(item => item.channel_id === selected.id) }) : <main id="chat-messages" className="chat-empty" tabIndex={-1}><div className="chat-empty-icon"><ChatCircle size={36} /></div><h1>A conversation starts here</h1><p>Choose a direct message or start a new one.</p><Button variant="primary" onClick={() => setNewOpen(true)}>New message</Button></main>}
    </div>
  </div>;
}
