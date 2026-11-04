import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import type { ChannelMember, ChannelUnread, DirectMessageSummary, Page } from '@space/contracts';
import { Avatar, Button, Dialog, IconButton } from '@space/ui';
import { ChatCircle, MagnifyingGlass, PencilSimple } from '@phosphor-icons/react';
import { request } from './chat-client.js';
import { subscribeUpdates } from './live-updates.js';
import { useWorkspaceUnread } from './useWorkspaceUnread.js';
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

export function NewDirectMessage({ workspace, viewer, onOpen, onClose }: { workspace: string; viewer: string; onOpen: (dm: DirectMessageSummary) => void; onClose: () => void }) {
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
      if (active.current) onOpen(dm);
    } catch (reason) { if (active.current) setError(errorText(reason)); }
    finally { opening.current = false; if (active.current) setBusy(false); }
  }
  const searching = !loaded || search !== query;
  return <Dialog open title="New message" description="Choose someone in your workspace to start or continue a direct message." onClose={onClose}>
    <div className="dm-recipient-search"><MagnifyingGlass size={18} /><label htmlFor="dm-recipient">To</label><input id="dm-recipient" type="search" autoFocus maxLength={100} placeholder="Find a person…" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></div>
    {error && <div role="alert" className="dm-error">{error}<Button size="sm" onClick={() => setRetry(value => value + 1)}>Retry</Button></div>}
    {searching ? <p role="status">Finding people…</p> : <ul className="dm-people" aria-label="People">{people.map(person => <li key={person.id}><button disabled={busy} onClick={() => void open(person)}><Avatar name={person.name} initials={person.name.slice(0, 2).toUpperCase()} size="sm" /><span><strong>{person.name}{person.id === viewer ? ' (you)' : ''}</strong><small>{person.id === viewer ? 'Your personal space' : person.title || 'Workspace member'}</small></span></button></li>)}</ul>}
    {!searching && !error && !people.length && <p>No people found. Try another name.</p>}
    {!searching && people.length === 30 && <p className="dm-hint">Showing the first 30 matches. Type a name to narrow your search.</p>}
    {busy && <p role="status">Opening conversation…</p>}
  </Dialog>;
}

type RoomControls = { close: () => Promise<void>; change: (dm: DirectMessageSummary) => void; readState?: ChannelUnread };
export function DirectMessages({ workspace, viewer, requestedId, compose = 0, width = 350, onVisit, onSearchAvailabilityChange, renderConversation }: {
  workspace: string; viewer: string; requestedId?: string; compose?: number; width?: number;
  onVisit: (dm?: DirectMessageSummary) => void; onSearchAvailabilityChange?: (available: boolean) => void;
  renderConversation: (dm: DirectMessageSummary, controls: RoomControls) => ReactNode;
}) {
  const [query, setQuery] = useState(''), search = useDebouncedValue(query), [after, setAfter] = useState('');
  const [unreads, setUnreads] = useState(false), [selected, setSelected] = useState<DirectMessageSummary>();
  const [newOpen, setNewOpen] = useState(Boolean(compose)), [error, setError] = useState('');
  const [mobileConversation, setMobileConversation] = useState(false);
  const list = useDirectMessageList(workspace, search, after, unreads), unread = useWorkspaceUnread(workspace);
  const active = useRef(true), selectedId = useRef<string | undefined>(undefined); selectedId.current = selected?.id;
  const visit = useRef(onVisit); visit.current = onVisit;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (compose) setNewOpen(true); }, [compose]);
  useEffect(() => { onSearchAvailabilityChange?.(!!selected); return () => onSearchAvailabilityChange?.(false); }, [selected?.id, onSearchAvailabilityChange]);
  function choose(dm: DirectMessageSummary) { selectedId.current = dm.id; setSelected(dm); setError(''); setNewOpen(false); setMobileConversation(true); visit.current(dm); requestAnimationFrame(() => document.querySelector<HTMLElement>('#chat-messages')?.focus()); }
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
  return <div className={`chat-layout dm-layout${mobileConversation && selected ? ' dm-layout--conversation' : ''}`} style={{ '--chat-sidebar-width': `${width}px` } as CSSProperties}>
    <aside id="chat-conversations" className="chat-sidebar dm-inbox" aria-label="Direct messages">
      <header className="dm-heading"><h2>Direct messages</h2><IconButton label="New message" onClick={() => setNewOpen(true)}><PencilSimple size={20} /></IconButton></header>
      <div className="dm-filter"><MagnifyingGlass size={17} /><input type="search" aria-label="Find a DM" placeholder="Find a DM…" maxLength={100} value={query} onChange={event => { setQuery(event.target.value); setAfter(''); }} /></div>
      <label className="dm-unreads"><input type="checkbox" checked={unreads} onChange={event => { setUnreads(event.target.checked); setAfter(''); }} />Unreads</label>
      {list.error && <div role="alert" className="dm-error">{list.error}<Button size="sm" onClick={() => void list.refresh()}>Retry</Button></div>}
      {!list.loaded || search !== query ? <p role="status">Loading direct messages…</p> : <ul className="dm-list">{items.map(dm => {
        const count = unread.channels.find(item => item.channel_id === dm.id)?.unread_count ?? 0;
        return <li key={dm.id}><button className={`dm-row${dm.id === selected?.id ? ' is-selected' : ''}${count ? ' is-unread' : ''}`} aria-label={`Open DM with ${dm.name}${count ? `, ${count} unread` : ''}`} aria-current={dm.id === selected?.id ? 'true' : undefined} onClick={() => choose(dm)}>
          <Avatar name={dm.name} initials={dm.name.slice(0, 2).toUpperCase()} size="sm" /><span className="dm-row-body"><strong>{dm.name}</strong><span>{dm.last_message?.text || (dm.last_message ? 'Shared a file' : dm.participants.length === 1 ? 'Notes, links, and files just for you' : 'Start a conversation')}</span></span>{count > 0 && <span className="dm-count">{count > 99 ? '99+' : count}</span>}
        </button></li>;
      })}</ul>}
      {list.loaded && !items.length && !list.error && <p className="dm-hint">{unreads ? 'No unread conversations.' : query ? 'No matching conversations.' : 'Your direct messages will appear here.'}</p>}
      <div className="dm-pages">{after && <Button size="sm" onClick={() => setAfter('')}>Back to newest</Button>}{list.next && <Button size="sm" onClick={() => setAfter(list.next!)}>More conversations</Button>}</div>
    </aside>
    <div className="dm-room">{selected && <button className="dm-back" onClick={() => setMobileConversation(false)}>← All direct messages</button>}{error && <p role="alert" className="dm-error">{error}</p>}
      {selected ? renderConversation(selected, { close, change: setSelected, readState: unread.channels.find(item => item.channel_id === selected.id) }) : <main id="chat-messages" className="chat-empty" tabIndex={-1}><div className="chat-empty-icon"><ChatCircle size={36} /></div><h1>A conversation starts here</h1><p>Choose a direct message or start a new one.</p><Button variant="primary" onClick={() => setNewOpen(true)}>New message</Button></main>}
    </div>
    {newOpen && <NewDirectMessage workspace={workspace} viewer={viewer} onClose={() => setNewOpen(false)} onOpen={dm => { choose(dm); setQuery(''); setAfter(''); setUnreads(false); void list.refresh(); }} />}
  </div>;
}
