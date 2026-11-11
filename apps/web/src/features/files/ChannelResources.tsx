import { useEffect, useState, type ComponentProps } from 'react';
import { Button, Tabs } from '@space/ui/primitives';
import { LinkSimple } from '@phosphor-icons/react';
import { safeLink } from '@space/ui/rich-text';
import type { ChannelLinkMessage, Page } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { ChannelFiles } from './ChannelFiles.js';

export function ChannelResources({ showLinksFirst, ...props }: ComponentProps<typeof ChannelFiles> & { showLinksFirst: boolean }) {
  const [view, setView] = useState(showLinksFirst ? 'links' : 'files');
  return <section id="channel-shared-content" className="channel-resources" aria-label="Files & links">
    <Tabs label="Shared content" items={[{id:'files',label:'Files'}, {id:'links',label:'Links'}]} value={view} onChange={setView}/>
    {view === 'files' ? <ChannelFiles {...props}/> : <ChannelLinks channel={props.channel} onMessage={props.onMessage}/>}
  </section>;
}

function ChannelLinks({ channel, onMessage }: { channel: string; onMessage: (id: string) => void }) {
  const [before, setBefore] = useState<string>(), [page, setPage] = useState<Page<ChannelLinkMessage>>();
  const [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPage(undefined); setError('');
    const stop = subscribeUpdates('channel', channel, async () => {
      try {
        const data = await request<Page<ChannelLinkMessage>>(`/channels/${channel}/links${before ? '?before='+before : ''}`, undefined, undefined, 'POST', controller.signal);
        if (controller.signal.aborted) return;
        if (before && !data.items.length) { setBefore(undefined); return; }
        setError(''); setPage(data);
      } catch {
        if (!controller.signal.aborted) { setPage(undefined); setError('Could not load shared links.'); }
      }
    }, () => { controller.abort(); setPage(undefined); setError('These links are no longer available.'); });
    return () => { controller.abort(); stop(); };
  }, [channel, before, retry]);
  return <div className="channel-links">
    {error ? <p role="alert">{error} <Button onClick={() => setRetry(i => i+1)}>Retry</Button></p>
      : !page ? <p role="status">Loading links…</p> : !page.items.length && <p>No links shared yet.</p>}
    <ul>{page?.items.flatMap(message => message.urls.map(url => {
      const href = safeLink(url);
      return href && /^https?:/i.test(href) ? <li key={message.id+url}><LinkSimple size={20}/>
        <div><a href={href} target="_blank" rel="noopener noreferrer">{url}</a>
          <button type="button" onClick={() => onMessage(message.id)}>View message</button></div>
      </li> : null;
    }))}</ul>
    {before && <Button size="sm" onClick={() => setBefore(undefined)}>Newest links</Button>}
    {page?.next_cursor && <Button size="sm" onClick={() => setBefore(page.next_cursor!)}>Older links</Button>}
  </div>;
}
