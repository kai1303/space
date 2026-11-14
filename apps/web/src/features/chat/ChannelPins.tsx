import { useEffect, useState } from 'react';
import type { ChannelPin, Page } from '@space/contracts';
import { Button, ListRowSkeleton, Menu, toast } from '@space/ui/primitives';
import { DotsThree, PushPin } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';

export function useChannelPins(channel: string | undefined, viewer: string) {
  const [result, setResult] = useState<{ channel: string; before?: string; page: Page<ChannelPin> }>();
  const current = result?.channel === channel ? result : undefined;
  const [attempt, setAttempt] = useState(0);
  const [before, setBefore] = useState<string>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!channel) { setResult(undefined); setBefore(undefined); setOpen(false); return; }
    if (!open) return;
    setError('');
    let active = true;
    const controller = new AbortController();
    function clear() { setResult(undefined); setBefore(undefined); setOpen(false); }
    const channelId = channel;
    async function read() {
      try {
        const next = await request<Page<ChannelPin>>(`/channels/${channel}/pins${before ? '?before=' + before : ''}`, undefined, undefined, 'POST', controller.signal);
        if (!active) return;
        if (!Array.isArray(next?.items)) throw new Error('Invalid pin list');
        setError('');
        if (!next.items.length && before) { setBefore(undefined); return; }
        setResult({channel: channelId, before, page: next});
      } catch (reason) {
        if (!active) return;
        if (reason instanceof Error && ['forbidden','not_found','unauthorized'].includes(reason.message)) clear();
        else setError('Could not load channel pins.');
      }
    }
    const stop = subscribeUpdates('channel', channel, read, () => { active = false; controller.abort(); clear(); });
    return () => { active = false; controller.abort(); stop(); };
  }, [channel, before, open, attempt]);
  function close() { setOpen(false); setBefore(undefined); setResult(undefined); setError(''); }
  async function change(id: string, pinned: boolean) {
    if (!channel) return;
    await request(`/channels/${channel}/pins/${id}`, pinned ? {} : undefined, undefined, pinned ? 'PUT' : 'DELETE', undefined, viewer);
    await invalidateUpdates('channel', channel);
  }
  return { page: current?.page, displayedBefore: current?.before, changingPage: !!current && current.before !== before, before, setBefore, retry: () => setAttempt(n => n + 1), open, show: () => setOpen(true), close, error, change };
}

export function ChannelPins({ pins, archived, onMessage }: {
  pins: ReturnType<typeof useChannelPins>; archived: boolean; onMessage: (id: string) => void;
}) {
  const [error, setError] = useState('');
  async function unpin(id: string) {
    setError('');
    try {
      await pins.change(id, false);
      toast.success('Message unpinned', {
        id: `unpin-${id}`, duration: 8000,
        action: { label: 'Undo', onClick: () => {
          void pins.change(id, true).then(
            () => toast.success('Message pinned to channel'),
            () => toast.error('Could not pin this message again.'),
          );
        } },
      });
    } catch { setError('Could not unpin this message. Try again.'); }
  }
  return <section className="channel-pins" aria-label="Pinned messages">
    {(error || pins.error) && <p role="alert">{error || pins.error} {pins.error && <Button size="sm" onClick={pins.retry}>Retry</Button>}</p>}
    {!pins.error && !pins.page && <ListRowSkeleton label="Loading pins…"/>}
    {!pins.error && pins.page?.items.length === 0 && <div className="channel-pins-empty"><PushPin size={32}/><h3>No pinned messages yet</h3><p>Choose “Pin to channel” from a message’s menu to keep it here.</p></div>}
    <ul>{pins.page?.items.map(pin => <li key={pin.id}>
      <PushPin size={17} aria-hidden="true"/>
      <button type="button" className="channel-pin-source" onClick={() => onMessage(pin.id)}>
        <span><strong>{pin.author}</strong> <time dateTime={pin.created_at}>{new Date(pin.created_at).toLocaleDateString()}</time></span>
        <span>{pin.text || 'Shared a file'}</span>
      </button>
      {!archived && <Menu floating label="Pinned message actions" trigger={<DotsThree size={19}/>} items={[{
        label: 'Unpin from channel', onSelect: () => void unpin(pin.id),
      }]}/>}
    </li>)}</ul>
    <footer>{pins.displayedBefore && <Button size="sm" loading={!pins.error && pins.changingPage && !pins.before} onClick={() => pins.error && !pins.before ? pins.retry() : pins.setBefore(undefined)}>Newest pins</Button>}
      {pins.page?.next_cursor && <Button size="sm" loading={!pins.error && pins.changingPage && !!pins.before} onClick={() => pins.error && pins.before === pins.page?.next_cursor ? pins.retry() : pins.setBefore(pins.page!.next_cursor!)}>Older pins</Button>}</footer>
  </section>;
}
