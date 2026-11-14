import { useEffect, useState, type ComponentProps } from 'react';
import { Button, Spinner, Tabs } from '@space/ui/primitives';
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
    {view === 'files' ? <ChannelFiles {...props}/> : <ChannelLinks key={props.channel} channel={props.channel} onMessage={props.onMessage}/>}
  </section>;
}

function ChannelLinks({ channel, onMessage }: { channel: string; onMessage: (id: string) => void }) {
  const [before, setBefore] = useState<string>(), [result, setResult] = useState<{before?: string; page: Page<ChannelLinkMessage>}>();
  const page = result?.page;
  const changingPage = result !== undefined && before !== result.before;
  const [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const stop = subscribeUpdates('channel', channel, async () => {
      try {
        const data = await request<Page<ChannelLinkMessage>>(`/channels/${channel}/links${before ? '?before='+before : ''}`, undefined, undefined, 'POST', controller.signal);
        if (controller.signal.aborted) return;
        if (before && !data.items.length) { setBefore(undefined); return; }
        setError(''); setResult({ before, page: data });
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof Error && ['unauthorized', 'forbidden', 'not_found'].includes(reason.message)) setResult(undefined);
        setError('Could not load shared links.');
      }
    }, () => { controller.abort(); setResult(undefined); setError('These links are no longer available.'); });
    return () => { controller.abort(); stop(); };
  }, [channel, before, retry]);
  return <div className="channel-links">
    {error ? <p role="alert">{error} <Button onClick={() => setRetry(i => i+1)}>Retry</Button></p>
      : !page ? <p className="channel-links-pending" role="status"><Spinner/>Loading links…</p> : !page.items.length && <p>No links shared yet.</p>}
    <ul>{page?.items.flatMap(message => message.urls.map(url => {
      const href = safeLink(url);
      return href && /^https?:/i.test(href) ? <li key={message.id+url}><LinkSimple size={20}/>
        <div><a href={href} target="_blank" rel="noopener noreferrer">{url}</a>
          <button type="button" onClick={() => onMessage(message.id)}>View message</button></div>
      </li> : null;
    }))}</ul>
    {result?.before && <Button size="sm" loading={!error && changingPage && !before} onClick={() => error && !before ? setRetry(n => n + 1) : setBefore(undefined)}>Newest links</Button>}
    {page?.next_cursor && <Button size="sm" loading={!error && changingPage && !!before} onClick={() => error && before === page.next_cursor ? setRetry(n => n + 1) : setBefore(page.next_cursor!)}>Older links</Button>}
  </div>;
}
