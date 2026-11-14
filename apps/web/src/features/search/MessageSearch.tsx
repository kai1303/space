import { useContext, useEffect, useId, useRef, useState } from 'react';
import { Avatar, Button, Dialog, IconButton, Popover, Spinner } from '@space/ui/primitives';
import { ArrowElbowDownLeft, CalendarBlank, CaretDown, Chats, Clock, Hash, LinkSimple, MagnifyingGlass, SlidersHorizontal, User, X } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { ChannelSearchHeaderContext } from './channel-search-header.js';
import { ConversationPanelDivider } from '../chat/ConversationPanelDivider.js';
import './message-search.css';

export type MessageSearchResult = { id: string; channel_id: string; channel_name: string; channel_kind: 'channel' | 'direct'; thread_id: string; text: string; created_at: string; author: { id: string; name: string }; is_reply: boolean };
type SearchPage = { items: MessageSearchResult[]; next_cursor: string | null };
type Recent = { label: string; onSelect: () => void };
type Props = { workspace: string; channel?: { id: string; name: string }; open: boolean; editRequest?: number; onChannelSubmit?: () => void; onClose: () => void; onSelect: (result: MessageSearchResult) => void; recents?: Recent[] };
const RECENT_LIMIT = 8;
const MAX_RESULTS = 500;
const tokens = (query: string) => query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
function filterValue(query: string, key: string) {
  return tokens(query).filter(token => token.toLowerCase().startsWith(`${key}:`)).at(-1)?.slice(key.length + 1).replace(/^"|"$/g, '') ?? '';
}
function withFilter(query: string, key: string, value: string) {
  const rest = tokens(query).filter(token => !token.toLowerCase().startsWith(`${key}:`));
  if (value.trim()) rest.push(`${key}:${/\s/.test(value.trim()) ? `"${value.trim()}"` : value.trim()}`);
  return rest.join(' ');
}
function Highlight({ text, query }: { text: string; query: string }) {
  const words = tokens(query).filter(token => !/^(in|from|has|is|before|after):/i.test(token)).map(token => token.replace(/^"|"$/g, '')).filter(token => token && token !== '*').slice(0, 30);
  const escaped = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a,b) => b.length-a.length);
  const expression = escaped.length ? new RegExp(`(${escaped.join('|')})`, 'gi') : undefined;
  const first = expression ? text.search(expression) : 0;
  const start = Math.max(0, first - 90), snippet = text.slice(start, start + 600);
  return <>{start > 0 && '…'}{expression ? snippet.split(expression).map((part,index) => index % 2 ? <mark key={index}>{part}</mark> : part) : snippet}{start + snippet.length < text.length && '…'}</>;
}
function Filters({ query, channel, onChange }: { query: string; channel?: Props['channel']; onChange: (query: string) => void }) {
  const link = filterValue(query,'has') === 'link', thread = filterValue(query,'is') === 'thread';
  return <div className="message-search-filters" role="toolbar" aria-label="Search filters">
    <span className="message-search-source"><Chats size={16}/> Messages</span>
    {(['from','in'] as const).map(key => key === 'in' && channel ? <span key={key} className="message-search-scope"><Hash size={16}/>{channel.name}</span> : <Popover key={key} label={key === 'from' ? 'From' : 'In'} floating align="start" className="message-search-filter" panelClassName="message-search-popover" triggerClassName={filterValue(query,key) ? 'is-selected' : ''}
      trigger={<>{key === 'from' ? <User size={15}/> : <Hash size={15}/>}<span>{key === 'from' ? 'From' : 'In'}{filterValue(query,key) ? `: ${filterValue(query,key)}` : ''}</span><CaretDown size={12}/></>}>
      {close => <form className="message-search-filter-form" onSubmit={event => {event.preventDefault();const data=new FormData(event.currentTarget);onChange(withFilter(query,key,String(data.get('value')??'')));close();}}>
        <label>{key === 'from' ? 'Person or agent' : 'Channel name'}<input autoFocus name="value" aria-label={key === 'from' ? 'Search author' : 'Search channel'} key={query} defaultValue={filterValue(query,key)} maxLength={100} pattern={'[^"\\r\\n]*'} placeholder={key === 'from' ? 'Name, or me' : 'e.g. general'}/></label>
        <small>{key === 'from' ? 'Use an exact name, or “me” for your messages.' : 'Use an exact channel name.'}</small>
        <div><Button size="sm" type="submit">Apply {key === 'from' ? 'author' : 'channel'}</Button><Button size="sm" type="button" onClick={() => {onChange(withFilter(query,key,''));close();}}>Clear</Button></div>
      </form>}
    </Popover>)}
    <button type="button" aria-pressed={link} onClick={() => onChange(withFilter(query,'has',link ? '' : 'link'))}><LinkSimple size={16}/>Has a link</button>
    <button type="button" aria-pressed={thread} onClick={() => onChange(withFilter(query,'is',thread ? '' : 'thread'))}><Chats size={16}/>Threads only</button>
    <Popover label="Date" floating align="start" className="message-search-filter" panelClassName="message-search-popover" triggerClassName={filterValue(query,'after') || filterValue(query,'before') ? 'is-selected' : ''} trigger={<><CalendarBlank size={16}/><span>Date</span><CaretDown size={12}/></>}>
      {close => <form className="message-search-filter-form" onSubmit={event => {event.preventDefault();const data=new FormData(event.currentTarget);onChange(withFilter(withFilter(query,'after',String(data.get('after')??'')),'before',String(data.get('before')??'')));close();}}>
        <label>On or after<input autoFocus type="date" name="after" key={`after:${query}`} defaultValue={filterValue(query,'after')}/></label>
        <label>Before<input type="date" name="before" key={`before:${query}`} defaultValue={filterValue(query,'before')}/></label>
        <small>Dates use UTC.</small><div><Button size="sm" type="submit">Apply dates</Button><Button size="sm" type="button" onClick={() => {onChange(withFilter(withFilter(query,'after',''),'before',''));close();}}>Clear</Button></div>
      </form>}
    </Popover>
  </div>;
}
export function MessageSearch(props: Props) {
  return props.open ? <SearchDialog key={`${props.workspace}:${props.channel?.id ?? ''}`} {...props} /> : null;
}
function SearchDialog({ workspace, channel, editRequest, onChannelSubmit, onClose, onSelect, recents = [] }: Props) {
  const [draft,setDraft] = useState(''), [query,setQuery] = useState(''), [cursor,setCursor] = useState<string>();
  const [attempt,setAttempt] = useState(0), [busy,setBusy] = useState(false), [showFilters,setShowFilters] = useState(false);
  const [items,setItems] = useState<MessageSearchResult[]>([]), [next,setNext] = useState<string|null>(null);
  const [error,setError] = useState(''), [searched,setSearched] = useState(false);
  const scopeId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(true);
  const [selected, setSelected] = useState<string>();
  const publishHeader = useContext(ChannelSearchHeaderContext);
  const pane = useRef<HTMLElement>(null);
  const channelName = channel?.name;
  useEffect(() => { setEditing(true); }, [editRequest]);
  useEffect(() => {
    if (!channelName || !query || !publishHeader) return;
    publishHeader({ label: `in:${channelName}${query === '*' ? '' : ' ' + query}`, edit: () => setEditing(true) });
    return () => publishHeader(null);
  }, [channelName, query, publishHeader]);
  useEffect(() => {
    if (channel && !editing) pane.current?.focus({ preventScroll: true });
  }, [channel?.id, editing]);
  function closePalette() {
    if (channel && query) { setDraft(query === '*' ? '' : query); setEditing(false); }
    else onClose();
  }
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    setBusy(true); setError('');
    void request<SearchPage>(`/workspaces/${encodeURIComponent(workspace)}/search?${new URLSearchParams({q:query,...(channel ? {channel_id:channel.id} : {}),...(cursor ? {cursor} : {})})}`,undefined,undefined,'POST',controller.signal).then(page => {
      if(controller.signal.aborted)return;
      setItems(previous => [...new Map([...(cursor ? previous : []),...page.items].map(item => [item.id,item])).values()].slice(0,MAX_RESULTS));
      setNext(page.next_cursor);setSearched(true);
    }).catch(reason => {
      if(controller.signal.aborted)return;
      const code=reason instanceof Error ? reason.message : '';
      setError(code==='search_unavailable' ? 'Search is temporarily unavailable. Please try again.' : code==='invalid_search' ? 'Check your search terms and filters. Dates use YYYY-MM-DD.' : 'Unable to search messages. Please try again.');
    }).finally(() => {if(!controller.signal.aborted)setBusy(false);});
    return () => controller.abort();
  },[workspace,channel?.id,query,cursor,attempt]);
  function submit(value=draft) {
    const trimmed=value.trim() || (channel ? '*' : '');
    if(!trimmed){input.current?.focus();return;}
    if(trimmed.length>500){setError('Keep your search under 500 characters.');return;}
    if (channel) { onChannelSubmit?.(); setEditing(false); setSelected(undefined); }
    setBusy(true);setDraft(trimmed === '*' && channel ? '' : trimmed);setQuery(trimmed);setCursor(undefined);setItems([]);setNext(null);setError('');setSearched(false);setAttempt(value=>value+1);
    input.current?.focus();
  }
  function changeFilter(value:string){if(query && !(channel && editing))submit(value || '*');else setDraft(value);}
  const field = <form className="message-search-input" role="search" onSubmit={event => {event.preventDefault();submit();}}>
        <MagnifyingGlass size={21} aria-hidden="true"/>
        {channel && <span id={scopeId} className="message-search-channel-token" title={`in:${channel.name}`}>in:{channel.name}</span>}
        <input ref={input} autoFocus type="search" aria-label="Search messages" aria-describedby={channel ? scopeId : undefined} placeholder={channel ? 'Search messages' : 'Search messages and replies'} maxLength={500} value={draft} onChange={event=>setDraft(event.target.value)}/>
        {draft && <IconButton label="Clear search text" onClick={()=>{setDraft('');input.current?.focus();}}><X size={17}/></IconButton>}
        {query && !channel ? <Button size="sm" type="submit">Search</Button> : <IconButton label="Show filters" aria-expanded={showFilters} onClick={()=>setShowFilters(value=>!value)}><SlidersHorizontal size={18}/></IconButton>}
        <IconButton label="Close search" onClick={closePalette}><X size={20}/></IconButton>
      </form>;
  const results = <div className="message-search-content">
        {!channel && <h2><span>Results for:</span> {query}</h2>}
        <Filters query={query} channel={channel} onChange={changeFilter}/>
        <div className="message-search-summary"><span>Newest first</span>{searched&&!error&&<span>{items.length}{next ? '+' : ''} {items.length===1&&!next ? 'message' : 'messages'} shown</span>}</div>
        <div className="message-search-results">
          {busy && !cursor && <p className="message-search-pending" role="status"><Spinner/>Searching messages…</p>}
          {error&&<div className="message-search-notice" role="alert"><p>{error}</p><Button size="sm" onClick={()=>setAttempt(value=>value+1)}>Retry search</Button></div>}
          {!busy&&!error&&searched&&!items.length&&<div className="message-search-empty"><MagnifyingGlass size={40}/><h3>No messages found</h3><p>Try a different keyword or remove a filter.</p></div>}
          {!!items.length&&<ul aria-label="Search results">{items.map(item=><li key={item.id}><button type="button" className="message-search-result" aria-current={channel && selected === item.id ? true : undefined} onClick={()=>{if (channel) setSelected(item.id); else onClose(); onSelect(item);}}>
            <Avatar name={item.author.name} initials={item.author.name.split(/\s+/).map(word=>word[0]).slice(0,2).join('').toUpperCase()} size="md"/>
            <span className="message-search-message"><span className="message-search-meta"><strong>{item.author.name}</strong><span>{item.channel_kind==='direct' ? 'Direct message · ' : '# '}{item.channel_name}</span><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString([], {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}</time></span>
              <span className="message-search-snippet"><Highlight text={item.text||'Shared a file'} query={query}/></span>
              {item.is_reply&&<span className="message-search-thread"><Chats size={14}/>Thread reply<span> · Open conversation</span></span>}
            </span>
          </button></li>)}</ul>}
          {next&&!error&&items.length<MAX_RESULTS&&<Button loading={busy && Boolean(cursor)} onClick={()=>setCursor(next)}>{busy && cursor ? 'Loading more results…' : 'Load more results'}</Button>}
          {items.length>=MAX_RESULTS&&<p>Showing the first {MAX_RESULTS} results. Refine your search to find more.</p>}
        </div>
      </div>;
  const suggestedQuery = draft.trim() || (channel ? `in:${channel.name}` : '');
  const suggestions = <>
        {showFilters&&<div className="message-search-palette-filters"><Filters query={draft} channel={channel} onChange={changeFilter}/></div>}
        {error&&<p role="alert" className="message-search-notice">{error}</p>}
        {suggestedQuery ? <button type="button" className="message-search-suggestion" aria-label={`Show results for: ${suggestedQuery}`} onClick={()=>submit()}><MagnifyingGlass size={20}/><span>Show results for: <strong>{suggestedQuery}</strong></span><kbd>Enter</kbd></button> : <div className="message-search-intro">{!channel && recents.length > 0 && <section className="message-search-recents" aria-label="Recent conversations"><span>Recent</span>{recents.slice(0, RECENT_LIMIT).map(item => <button type="button" key={item.label} onClick={item.onSelect}><Clock size={18}/>{item.label}</button>)}</section>}<span>Find a message</span><p>Search your conversations, including older messages and replies.</p><button type="button" onClick={()=>{setDraft('from:me ');input.current?.focus();}}><User size={18}/>Messages from you<code>from:me</code></button><button type="button" onClick={()=>{setDraft('has:link ');input.current?.focus();}}><LinkSimple size={18}/>Messages with links<code>has:link</code></button></div>}
        <footer className="message-search-footer"><span><ArrowElbowDownLeft size={14}/> Enter to search</span><span><kbd>esc</kbd> to close</span><span>Use “quotes” for exact phrases</span></footer>
      </>;
  const palette = !!channel || !query;
  return <>
    {channel && query && <>
      <ConversationPanelDivider files={false}/>
      <aside ref={pane} tabIndex={-1} className="channel-search-pane" aria-label={`Search results in ${channel.name}`}
        onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onClose(); } }}>
        <header>
          <button type="button" className="channel-search-query" onClick={() => setEditing(true)}>
            <MagnifyingGlass size={17}/><span>{query === '*' ? 'All messages' : query} in {channel.name}</span>
          </button>
          <IconButton label="Close search results" onClick={onClose}><X size={19}/></IconButton>
        </header>
        {results}
      </aside>
    </>}
    {(!channel || editing) && <Dialog open title={channel ? `Search in ${channel.name}` : 'Search workspace'} onClose={closePalette}>
      <div data-scope={channel ? 'channel' : 'workspace'} className={`message-search message-search--${palette ? 'palette' : 'results'}`} onKeyDown={event => {
        if (event.key === 'Escape' && !event.defaultPrevented && !(event.target as HTMLElement).closest('details[open]')) {
          event.preventDefault(); event.stopPropagation(); closePalette();
        }
      }}>
        {field}
        {palette ? suggestions : results}
      </div>
    </Dialog>}
  </>;
}
