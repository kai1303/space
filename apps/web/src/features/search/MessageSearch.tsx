import { useEffect, useState } from 'react';
import { Button, Dialog, TextField } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import './message-search.css';

export type MessageSearchResult = { id: string; channel_id: string; channel_name: string; channel_kind: 'channel' | 'direct'; thread_id: string; text: string; created_at: string; author: { id: string; name: string }; is_reply: boolean };
type SearchPage = { items: MessageSearchResult[]; next_cursor: string | null };
type Props = { workspace: string; channel?: { id: string; name: string }; open: boolean; onClose: () => void; onSelect: (result: MessageSearchResult) => void };
const MAX_RESULTS = 500;

export function MessageSearch(props: Props) {
  return props.open ? <SearchDialog key={`${props.workspace}:${props.channel?.id ?? ''}`} {...props} /> : null;
}
function SearchDialog({ workspace, channel, onClose, onSelect }: Props) {
  const [query, setQuery] = useState(''), [cursor, setCursor] = useState<string>();
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false);
  const [items, setItems] = useState<MessageSearchResult[]>([]), [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState(''), [searched, setSearched] = useState(false);
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    setBusy(true); setError('');
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim() });
      if (channel) params.set('channel_id', channel.id);
      if (cursor) params.set('cursor', cursor);
      void request<SearchPage>(`/workspaces/${encodeURIComponent(workspace)}/search?${params}`, undefined, undefined, 'POST', controller.signal).then(page => {
        if (controller.signal.aborted) return;
        setItems(previous => [...new Map([...(cursor ? previous : []), ...page.items].map(item => [item.id, item])).values()].slice(0, MAX_RESULTS));
        setNext(page.next_cursor); setSearched(true);
      }).catch(reason => {
        if (controller.signal.aborted) return;
        const code = reason instanceof Error ? reason.message : '';
        setError(code === 'search_unavailable' ? 'Search is temporarily unavailable. Please try again.' : code === 'invalid_search' ? 'Check your search terms and filters. Dates use YYYY-MM-DD.' : 'Unable to search messages. Please try again.');
      }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, cursor || attempt ? 0 : 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [workspace, channel?.id, query, cursor, attempt]);
  function changeQuery(value: string) {
    setQuery(value.slice(0, 500)); setCursor(undefined); setItems([]); setNext(null); setError(''); setSearched(false); setBusy(false); setAttempt(0);
  }
  return <Dialog open title={channel ? `Search in ${channel.name}` : 'Search workspace'} onClose={onClose}>
    <div className="message-search">
      <TextField autoFocus type="search" label="Search messages" placeholder="Search messages and replies" maxLength={500} value={query} onChange={event => changeQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }} hint={'Use "exact phrases", in:channel, from:me, from:name, has:link, is:thread, before:2026-11-04 or after:2026-11-01.'} />
      <div className="message-search-results" aria-busy={busy}>
        {busy && <p role="status">Searching messages…</p>}
        {error && <div role="alert"><p>{error}</p><Button size="sm" onClick={() => setAttempt(value => value + 1)}>Retry search</Button></div>}
        {!query.trim() && <p>Search your accessible conversations, including older messages and replies.</p>}
        {!busy && !error && searched && !items.length && <p>No messages found</p>}
        {!!items.length && <ul aria-label="Search results">{items.map(item => <li key={item.id}><button type="button" className="message-search-result" onClick={() => { onClose(); onSelect(item); }}>
          <span className="message-search-meta"><strong>{item.author.name}</strong><span>{item.channel_kind === 'direct' ? '' : '#'}{item.channel_name}{item.is_reply ? ' · Thread reply' : ''}</span><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleDateString()}</time></span>
          <span className="message-search-snippet">{item.text || 'Shared a file'}</span>
        </button></li>)}</ul>}
        {next && !error && items.length < MAX_RESULTS && <Button disabled={busy} onClick={() => setCursor(next)}>Load more results</Button>}
        {items.length >= MAX_RESULTS && <p>Showing the first {MAX_RESULTS} results. Refine your search to find more.</p>}
      </div>
    </div>
  </Dialog>;
}
