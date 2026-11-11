import { useEffect, useState } from 'react';
import type { ChannelPin, Page } from '@space/contracts';
import { Button, Menu } from '@space/ui/primitives';
import { DotsThree, PushPin } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';

export function useChannelPins(channel: string | undefined, viewer: string) {
  const [page, setPage] = useState<Page<ChannelPin>>();
  const [before, setBefore] = useState<string>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!channel) { setPage(undefined); setBefore(undefined); setOpen(false); return; }
    if (!open) return;
    let active = true;
    const controller = new AbortController();
    function clear() { setPage(undefined); setBefore(undefined); setOpen(false); }
    async function read() {
      try {
        const next = await request<Page<ChannelPin>>(`/channels/${channel}/pins${before ? '?before=' + before : ''}`, undefined, undefined, 'POST', controller.signal);
        if (!active) return;
        if (!Array.isArray(next?.items)) throw new Error('Invalid pin list');
        setError('');
        if (!next.items.length && before) { setBefore(undefined); return; }
        setPage(next);
      } catch (reason) {
        if (!active) return;
        if (reason instanceof Error && ['forbidden','not_found','unauthorized'].includes(reason.message)) clear();
        else setError('Could not load channel pins.');
      }
    }
    const stop = subscribeUpdates('channel', channel, read, () => { active = false; controller.abort(); clear(); });
    return () => { active = false; controller.abort(); stop(); };
  }, [channel, before, open]);
  function close() { setOpen(false); setBefore(undefined); setPage(undefined); setError(''); }
  async function change(id: string, pinned: boolean) {
    if (!channel) return;
    await request(`/channels/${channel}/pins/${id}`, pinned ? {} : undefined, undefined, pinned ? 'PUT' : 'DELETE', undefined, viewer);
    await invalidateUpdates('channel', channel);
  }
  return { page, before, setBefore, open, show: () => setOpen(true), close, error, change };
}

export function ChannelPins({ pins, archived, onMessage }: {
  pins: ReturnType<typeof useChannelPins>; archived: boolean; onMessage: (id: string) => void;
}) {
  const [error, setError] = useState('');
  return <section className="channel-pins" aria-label="Pinned messages">
    {(error || pins.error) && <p role="alert">{error || pins.error}</p>}
    {!pins.error && !pins.page && <p role="status">Loading pins…</p>}
    {!pins.error && pins.page?.items.length === 0 && <div className="channel-pins-empty"><PushPin size={32}/><h3>No pinned messages yet</h3><p>Choose “Pin to channel” from a message’s menu to keep it here.</p></div>}
    <ul>{pins.page?.items.map(pin => <li key={pin.id}>
      <PushPin size={17} aria-hidden="true"/>
      <button type="button" className="channel-pin-source" onClick={() => onMessage(pin.id)}>
        <span><strong>{pin.author}</strong> <time dateTime={pin.created_at}>{new Date(pin.created_at).toLocaleDateString()}</time></span>
        <span>{pin.text || 'Shared a file'}</span>
      </button>
      {!archived && <Menu floating label="Pinned message actions" trigger={<DotsThree size={19}/>} items={[{
        label: 'Unpin from channel', onSelect: () => {
          setError(''); void pins.change(pin.id, false).catch(() => setError('Could not unpin this message. Try again.'));
        },
      }]}/>}
    </li>)}</ul>
    <footer>{pins.before && <Button size="sm" onClick={() => pins.setBefore(undefined)}>Newest pins</Button>}
      {pins.page?.next_cursor && <Button size="sm" onClick={() => pins.setBefore(pins.page!.next_cursor!)}>Older pins</Button>}</footer>
  </section>;
}
