import { useEffect, useState } from 'react';
import { defaultChannelTabOrder, type ChannelTabsState, type ManagedChannelTab } from '@space/contracts';
import { IconButton, Menu, Spinner } from '@space/ui/primitives';
import { ArrowDown, ArrowUp, BookOpen, ChatCircle, Compass, Eye, EyeSlash, Paperclip, Plus, PushPin, SlidersHorizontal } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';

export const channelTabNames = { files: 'Files & links', pins: 'Pins', memory: 'Memory', navigator: 'Navigator' } as const;

export function useChannelTabs(channel: string | undefined, actor: string) {
  const [state, setState] = useState<ChannelTabsState>();
  const [error, setError] = useState('');
  useEffect(() => {
    setState(undefined); setError('');
    if (!channel) return;
    const controller = new AbortController();
    const stop = subscribeUpdates('channel', channel, async () => {
      try {
        const data = await request<ChannelTabsState>(`/channels/${channel}/tabs`, undefined, undefined, 'POST', controller.signal);
        if (!controller.signal.aborted && data?.visibility) { setState(data); setError(''); }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && ['not_found','unauthorized','forbidden'].includes(e.message)) setState(undefined);
        setError('Could not load channel tabs.');
      }
    }, () => { controller.abort(); setState(undefined); setError('Channel tabs are unavailable.'); });
    return () => { controller.abort(); stop(); };
  }, [channel, actor]);
  const visible = (tab: ManagedChannelTab) => state?.visibility[tab] ??
    (tab === 'files' ? !!(state?.has_files || state?.has_links) : tab === 'pins' && !!state?.has_pins);
  async function change(tab: ManagedChannelTab, visible: boolean) {
    if (!channel) return;
    await request(`/channels/${channel}/tabs/${tab}`, { visible }, undefined, 'PUT', undefined, actor);
    await invalidateUpdates('channel', channel);
  }
  const order = state?.order ?? defaultChannelTabOrder;
  const [moving, setMoving] = useState(false), [moveError,setMoveError] = useState('');
  async function move(tab:string, target:string, side:'before'|'after') {
    if (!channel || moving) return;
    setMoving(true); setMoveError('');
    try {
      await request(`/channels/${channel}/tabs/order`, {tab,target,side}, undefined, 'PUT', undefined, actor);
      await invalidateUpdates('channel',channel);
    } catch { setMoveError('Could not reorder tabs. Try again.'); }
    finally { setMoving(false); }
  }
  return {state, error, visible, change, order, move, moving, moveError};
}

export function ChannelTabMenu({ onMemory, onNavigator, onCustomize }: {
  onMemory: () => void; onNavigator: () => void; onCustomize: () => void;
}) {
  return <Menu className="channel-tab-menu" floating align="start" label="Add or manage tabs" trigger={<Plus size={17}/>} items={[
    { label: 'Memory', icon: <BookOpen size={16}/>, onSelect: onMemory },
    { label: 'Navigator', icon: <Compass size={16}/>, onSelect: onNavigator },
    { label: 'Customize tabs', icon: <SlidersHorizontal size={16}/>, separatorBefore: true, onSelect: onCustomize },
  ]}/>;
}

export const channelTabIcons = { files: Paperclip, pins: PushPin, memory: BookOpen, navigator: Compass };


export function ChannelTabManager({ channel, actor, archived }: {channel: string; actor: string; archived: boolean}) {
  const tabs = useChannelTabs(channel, actor);
  const [pending, setPending] = useState<Partial<Record<ManagedChannelTab, boolean>>>({});
  const [error, setError] = useState('');
  async function change(tab: ManagedChannelTab, show: boolean) {
    if (pending[tab] !== undefined || archived) return;
    setPending(current => ({...current, [tab]: show})); setError('');
    try { await tabs.change(tab, show); } catch { setError('Could not save this change. Try again.'); }
    finally { setPending(current => { const next = {...current}; delete next[tab]; return next; }); }
  }
  const {order} = tabs;
  const hidden = order.filter(tab => !tabs.visible(tab) && pending[tab] === undefined);
  return <section className="space-channel-card channel-tab-manager" aria-label="Manage tabs">
    <h3>Manage tabs</h3><p>Reorder, show, or hide tabs for everyone in this channel.</p>
    <ul aria-label="Channel tabs">
      <li><ChatCircle size={16}/>Messages</li>
      {tabs.state && order.map((tab,index) => {
        const shown = pending[tab] ?? tabs.visible(tab);
        const Icon = channelTabIcons[tab], Action = shown ? EyeSlash : Eye;
        return <li key={tab} data-hidden={!shown || undefined}><Icon size={16}/><span>{channelTabNames[tab]}</span>
          {!shown && <small>Hidden</small>}
          <div className="channel-tab-actions">
          <IconButton label={`Move ${channelTabNames[tab]} up`} size="sm" disabled={archived || tabs.moving || index === 0}
            onClick={() => void tabs.move(tab,order[index-1]!,'before')}><ArrowUp size={16}/></IconButton>
          <IconButton label={`Move ${channelTabNames[tab]} down`} size="sm" disabled={archived || tabs.moving || index === order.length-1}
            onClick={() => void tabs.move(tab,order[index+1]!,'after')}><ArrowDown size={16}/></IconButton>
          <IconButton label={`${shown ? 'Hide' : 'Show'} ${channelTabNames[tab]} tab`} size="sm"
            aria-busy={pending[tab] !== undefined || undefined} disabled={pending[tab] !== undefined || archived} onClick={() => void change(tab,!shown)}><Action size={17}/></IconButton></div>
        </li>;
      })}
    </ul>
    {!tabs.state && !tabs.error && <p className="space-channel-pending" role="status"><Spinner/>Loading tabs…</p>}
    {tabs.state && !archived && hidden.length > 0 && <Menu align="start" floating label="New tab" trigger={<><Plus size={15}/> New Tab</>}
      items={hidden.map(tab => ({label:channelTabNames[tab],onSelect:() => void change(tab,true)}))}/>}
    {(error || tabs.moveError || tabs.error) && <p role="alert" className="space-channel-error">{error || tabs.moveError || tabs.error}</p>}
  </section>;
}
