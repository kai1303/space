import {useDestinationPresence} from '../../shared/ui/useDestinationPresence.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NotificationActivity, NotificationItem, NotificationSettings } from '@space/contracts';
import { Tabs, Select, Avatar, Button, Dialog, IconButton } from '@space/ui/primitives';
import { At, Bell, BellSlash, ChatCircle, Chats, Check, Checks, GearSix, Hash, Smiley } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { useWorkspaceQueryCache, readWorkspaceQuery } from '../../shared/realtime/workspace-query-cache.js';
import { acquireRealtime } from '../../shared/realtime/socket-session.js';
import type { ActivityView } from './view-state.js';
import type { Snapshot } from '../../shared/ui/view-state.js';
import { createNotificationSound } from './notification-sound.js';
import './notifications.css';

const failure = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to load notifications';
const denied = (error: unknown) => error instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(error.message);
const empty: NotificationActivity = { sound_enabled: false, items: [], unread_count: 0, next_cursor: null, latest_id: '0' };
const tabs = [['', 'All'], ['direct_message', 'DMs'], ['mention', 'Mentions'], ['thread_reply', 'Threads'], ['reaction', 'Reactions']] as const;
const labels = { mention: 'Mentioned you', direct_message: 'Direct message', thread_reply: 'Replied to a thread', reaction: 'Reacted to your message', channel_message: 'New channel message' };

// Each page is scoped and cancellable; subscriptions coalesce events and recover on reconnect.
function useActivity(workspace: string, kind = '', unread = false, before = '') {
  const cache = useWorkspaceQueryCache(workspace);
  const pageCache = before ? undefined : cache;
  const base = `/workspaces/${workspace}/notifications`;
  const params = new URLSearchParams({ ...(kind ? { kind } : {}), ...(unread ? { unread: 'true' } : {}), ...(before ? { before } : {}) }).toString();
  const path = params ? `${base}?${params}` : base;
  const [state, setState] = useState<{ cache: typeof cache; path: string; page: NotificationActivity; error: string }>();
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!workspace) return;
    let active = true, revision = 0; let controller: AbortController | undefined;
    const read = async () => {
      const version = ++revision; controller?.abort(); controller = new AbortController();
      try {
        const page = await readWorkspaceQuery<NotificationActivity>(pageCache, path, controller.signal);
        if (!Array.isArray(page?.items)) { cache?.invalidate(path); throw new Error('Invalid notification response'); }
        if (active && version === revision) setState({ cache, path, page, error: '' });
      } catch (error) {
        if (!active || version !== revision || (error instanceof Error && error.name === 'AbortError')) return;
        const accessLost = denied(error);
        if (accessLost) cache?.invalidate(base);
        setState(old => ({
          cache, path, page: !accessLost && old?.path === path && old.cache === cache ? old.page : empty,
          error: failure(error),
        }));
      }
    };
    refresh.current = read;
    const stop = subscribeUpdates('workspace', workspace, read, code => { revision++; controller?.abort(); cache?.invalidate(base); setState({ cache, path, page: empty, error: failure(new Error(code)) }); });
    return () => { active = false; revision++; controller?.abort(); stop(); };
  }, [workspace, cache, pageCache, base, path]);
  const current = state?.path === path && state.cache === cache ? state : undefined;
  const warm = current ? undefined : pageCache?.peek<NotificationActivity>(path);
  const page = current?.page ?? (Array.isArray(warm?.items) ? warm : undefined);
  return {
    page: page ?? empty, loaded: !!page, error: current?.error ?? '',
    refresh: () => refresh.current(),
    invalidate: () => cache?.invalidate(base),
  };
}

type ActivityProps = { workspace: string; onOpen: (item: NotificationItem) => void; viewState?: Snapshot<ActivityView> };

const peekContexts = {
  mention: { icon: At, label: 'Mention in' },
  direct_message: { icon: ChatCircle, label: 'Direct message from' },
  thread_reply: { icon: Chats, label: 'Thread in' },
  reaction: { icon: Smiley, label: 'Reaction in' },
  channel_message: { icon: Hash, label: 'Message in' },
} as const;

function peekTime(createdAt: string) {
  const date = new Date(createdAt);
  const today = new Date();
  if (today.toDateString() === date.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const weekAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
  return date >= weekAgo
    ? date.toLocaleDateString([], { weekday: 'long' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function ActivityPeekRow({ item, onOpen, busy }: { item: NotificationItem; onOpen: (item: NotificationItem) => void; busy: boolean }) {
  const { icon: ContextIcon, label } = peekContexts[item.kind];
  return <li className={item.read_at ? '' : 'is-unread'}>
    <button type="button" className="activity-peek-row" disabled={busy} onClick={() => onOpen(item)}
      aria-label={`Open notification from ${item.author_name}: ${item.text || labels[item.kind]}`}>
      <Avatar name={item.author_name} initials={item.author_name.slice(0, 2).toUpperCase()}/>
      <span className="activity-peek-copy">
        <span className="activity-peek-sender">
          <strong>{item.author_name}</strong>
          <time dateTime={item.created_at} title={new Date(item.created_at).toLocaleString()}>{peekTime(item.created_at)}</time>
        </span>
        <span className="activity-peek-message">{item.text || 'Shared a file'}</span>
        <span className="activity-peek-context">
          <ContextIcon size={16} aria-hidden="true"/>
          <span>{label}</span>
          <strong>{item.channel_kind === 'direct' ? item.channel_name : `#${item.channel_name}`}</strong>
          {item.emoji && <span>{item.emoji}</span>}
          {item.silent && <BellSlash size={14} aria-label="Silent"/>}
        </span>
      </span>
    </button>
  </li>;
}

export function ActivityPeek(props: Omit<ActivityProps, 'viewState'>) {
  return <Notifications {...props} preview />;
}

export function Notifications({ workspace, onOpen, viewState, preview = false }: ActivityProps & { preview?: boolean }) {
  const present=useDestinationPresence();
  const localView=useRef<ActivityView>({kind:'',unread:false,before:'',scroll:0}), view=viewState??localView;
  const pageRef=useRef<HTMLElement>(null);
  const [kind, setKind] = useState(view.current.kind), [unread, setUnread] = useState(view.current.unread), [before, setBefore] = useState(view.current.before);
  useLayoutEffect(()=>{view.current={...view.current,kind,unread,before};},[view,kind,unread,before]);
  const [preferences, setPreferences] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { page, loaded, error: readError, refresh, invalidate } = useActivity(workspace, kind, unread, before);
  useLayoutEffect(()=>{if(loaded&&pageRef.current)pageRef.current.scrollTop=view.current.scroll;},[loaded,view]);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function change(work: () => Promise<unknown>, done?: () => void) {
    if (busy) return; setBusy(true); setError('');
    try { await work(); invalidate(); if (active.current && present.current) { done?.(); await refresh(); } }
    catch (reason) { if (active.current) setError(failure(reason)); }
    finally { if (active.current) setBusy(false); }
  }
  const mark = (item: NotificationItem, read: boolean, open = false) => change(() => request(`/workspaces/${workspace}/notifications/${item.id}`, { read }, undefined, 'PATCH'), open ? () => onOpen(item) : undefined);
  function openNotification(item: NotificationItem) {
    if (preview) {
      // A deliberate navigation must survive the transient panel being dismissed.
      if (!item.read_at) void mark(item, true);
      onOpen(item);
    } else {
      void mark(item, true, true);
    }
  }
  function openButton(item: NotificationItem) {
    const timestamp = new Date(item.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return <button className="notification-open"
      aria-label={`Open notification from ${item.author_name}: ${item.text || labels[item.kind]}`}
      disabled={busy} onClick={() => openNotification(item)}>
      <Avatar name={item.author_name} initials={item.author_name.slice(0, 2).toUpperCase()} size="sm"/>
      <span className="notification-copy">
        <span className="notification-meta">
          <strong>{item.author_name}</strong><span>{labels[item.kind]}{item.emoji ? ` ${item.emoji}` : ''}</span>
          <time dateTime={item.created_at}>{timestamp}</time>
        </span>
        <span className="notification-preview">{item.text || 'Shared a file'}</span>
        <span className="notification-context">{item.channel_kind === 'direct' ? item.channel_name : `#${item.channel_name}`}{item.silent && <><BellSlash size={12}/> Silent</>}</span>
      </span>
    </button>;
  }
  if (preview) return <>
    <header className="rail-peek-header"><h2>Activity</h2>
      <button type="button" className="activity-peek-switch" aria-pressed={unread} onClick={() => setUnread(value => !value)}>
        Unreads<span aria-hidden="true"/>
      </button>
    </header>
    {(readError || error) && <p role="alert" className="rail-peek-empty">{readError || error} <Button size="sm" onClick={() => void refresh()}>Retry</Button></p>}
    {!loaded ? <p role="status" className="rail-peek-empty">Loading activity…</p>
      : page.items.length ? <ul className="rail-peek-list activity-peek-list" aria-label="Activity">{page.items.map(item =>
        <ActivityPeekRow key={item.id} item={item} onOpen={openNotification} busy={busy}/>
      )}</ul>
      : !readError && <div className="activity-peek-empty"><h3>All caught up</h3><p>New activity will appear here when someone mentions you or replies.</p></div>}
  </>;
  return <main ref={pageRef} onScroll={event=>{view.current.scroll=event.currentTarget.scrollTop;}} id="chat-messages" tabIndex={-1} className="notification-activity">
    <header className="notification-heading"><div><h1>Activity</h1><p>Catch up on the conversations that need you.</p></div><IconButton label="Notification settings" onClick={() => setPreferences(true)}><GearSix size={22}/></IconButton></header>
    <Tabs className="notification-tabs" label="Activity types" value={kind} items={tabs.map(([id,label])=>({id,label}))} onChange={value=>{setKind(value);setBefore('');view.current.scroll=0;}}/>
    <div className="notification-toolbar"><label><input type="checkbox" checked={unread} onChange={event => { setUnread(event.target.checked); setBefore(''); }}/>Unreads</label><span>{page.unread_count} unread</span><Button size="sm" disabled={busy || !page.unread_count || !loaded} onClick={() => void change(() => request(`/workspaces/${workspace}/notifications/read`, { through: page.latest_id }))}><Checks size={17}/>Mark all as read</Button></div>
    {(readError || error) && <p role="alert" className="notification-error">{readError || error}<Button size="sm" onClick={() => void refresh()}>Retry</Button></p>}
    {!loaded ? <p role="status" className="notification-empty">Loading activity…</p> : !page.items.length && !readError ? <div className="notification-empty"><Bell size={38}/><h2>You’re all caught up</h2><p>{unread ? 'No unread notifications in this view.' : 'New messages, mentions, replies, and reactions will appear here.'}</p></div> : <ul className="notification-list">{page.items.map(item => <li key={item.id} className={item.read_at ? '' : 'is-unread'}>
      {openButton(item)}
      <IconButton label={item.read_at ? `Mark notification ${item.id} unread` : `Mark notification ${item.id} read`} disabled={busy} onClick={() => void mark(item, !item.read_at)}>{item.read_at ? <Bell size={18}/> : <Check size={18}/>}</IconButton>
    </li>)}</ul>}
    <footer className="notification-pages">{before && <Button size="sm" onClick={() => setBefore('')}>Back to newest</Button>}{page.next_cursor && <Button size="sm" onClick={() => setBefore(page.next_cursor!)}>Older activity</Button>}</footer>
    {preferences && <NotificationPreferences workspace={workspace} onClose={() => setPreferences(false)}/>}
  </main>;
}

export function NotificationPreferences({ workspace, onClose, title = "Notification settings" }: { title?: string; workspace: string; onClose: () => void }) {
  const [settings, setSettings] = useState<NotificationSettings>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<string>(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const active = useRef(true), revision = useRef(0), scope = useRef(0);
  const retry = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const sync = () => setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);
  useEffect(() => {
    active.current = true; scope.current++;
    const read = async () => {
      const version = ++revision.current;
      try { const next = await request<NotificationSettings>(`/workspaces/${workspace}/notification-settings`); if (active.current && version === revision.current) { setSettings(next); setError(''); } }
      catch (reason) { if (active.current && version === revision.current) { if (denied(reason)) setSettings(undefined); setError(failure(reason)); } }
    };
    retry.current = read;
    const stop = subscribeUpdates('workspace', workspace, read, code => { scope.current++; revision.current++; setSettings(undefined); setError(failure(new Error(code))); });
    return () => { active.current = false; scope.current++; revision.current++; stop(); };
  }, [workspace]);
  async function save(patch: Partial<NotificationSettings>) {
    if (busy) return; revision.current++; setBusy(true); setError('');
    const version = scope.current;
    try { const next = await request<NotificationSettings>(`/workspaces/${workspace}/notification-settings`, patch, undefined, 'PATCH'); if (active.current && version === scope.current) { revision.current++; setSettings(next); } }
    catch (reason) { if (active.current) setError(failure(reason)); }
    finally { if (active.current) setBusy(false); }
  }
  async function enable() {
    if (typeof Notification === 'undefined') return;
    try {
      const result = await Notification.requestPermission(); if (!active.current) return; setPermission(result);
      if (result === 'granted') await save({ desktop_enabled: true });
    } catch (reason) { if (active.current) setError(failure(reason)); }
  }
  const paused = !!settings?.paused_until && Date.parse(settings.paused_until) > Date.now();
  return <Dialog open title={title} onClose={onClose}><div className="notification-preferences">
    {title === "Preferences" && <h3>Notifications</h3>}
    <p>Activity keeps your notifications even when alerts are paused. These preferences apply across your workspaces.</p>
    {error && <p role="alert">{error}<Button size="sm" onClick={() => void retry.current()}>Retry preferences</Button></p>}
    {!settings ? <p role="status">Loading preferences…</p> : <>
      <label>Notify me about<Select aria-label="Notify me about" disabled={busy} value={settings.mode} onChange={event => void save({ mode: event.target.value as NotificationSettings['mode'] })}><option value="mentions">Mentions and direct messages</option><option value="all">All new messages in joined channels</option><option value="none">Nothing — keep Activity only</option></Select></label>
      <label className="notification-checkbox"><input type="checkbox" checked={settings.thread_replies} disabled={busy} onChange={event => void save({ thread_replies: event.target.checked })}/>Also alert me about followed thread replies</label>
      <label className="notification-checkbox"><input type="checkbox" checked={settings.sound_enabled} disabled={busy} onChange={event => void save({ sound_enabled: event.target.checked })}/>Play a sound for notifications</label>
      <section><h3>Desktop alerts</h3><p>Delivered by this browser while Space is open. Your browser and operating system control whether banners appear.</p>
        {permission === 'unsupported' ? <p>This browser does not support desktop alerts.</p> : permission === 'denied' ? <p role="status">Desktop alerts are blocked in your browser. Allow notifications for Space in site settings to enable them.</p> : settings.desktop_enabled && permission === 'granted' ? <Button size="sm" disabled={busy} onClick={() => void save({ desktop_enabled: false })}>Disable desktop alerts</Button> : <Button size="sm" disabled={busy} onClick={() => void enable()}>Enable desktop alerts</Button>}
      </section>
      <label className="notification-checkbox"><input type="checkbox" checked={settings.preview_enabled} disabled={busy} onChange={event => void save({ preview_enabled: event.target.checked })}/>Include sender and message preview in desktop alerts</label>
      <section><h3>Pause notifications</h3><p>{paused ? `Paused until ${new Date(settings.paused_until!).toLocaleString()}` : 'Alerts are not paused.'}</p><div className="notification-pause">{paused && <Button size="sm" disabled={busy} onClick={() => void save({ paused_until: null })}>Resume notifications</Button>}<Button size="sm" disabled={busy} onClick={() => void save({ paused_until: new Date(Date.now() + 15 * 60000).toISOString() })}>Pause for 15 minutes</Button><Button size="sm" disabled={busy} onClick={() => void save({ paused_until: new Date(Date.now() + 3600000).toISOString() })}>Pause for 1 hour</Button></div></section>
    </>}
  </div></Dialog>;
}

export function ThreadNotificationToggle({ thread }: { thread: string }) {
  const [following, setFollowing] = useState<boolean>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const revision = useRef(0), mounted = useRef(true), mutating = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true; mounted.current = true; setFollowing(undefined);
    const read = async () => {
      if (mutating.current) return;
      const version = ++revision.current;
      try { const value = await request<{ following: boolean }>(`/threads/${thread}/notification-subscription`); if (active && version === revision.current) { setFollowing(value.following); setError(''); } }
      catch (reason) { if (active && version === revision.current) setError(failure(reason)); }
    };
    refresh.current = read;
    const stop = subscribeUpdates('thread', thread, read, code => { revision.current++; if (active) { setFollowing(undefined); setError(failure(new Error(code))); } });
    return () => { active = false; mounted.current = false; revision.current++; stop(); };
  }, [thread]);
  async function toggle() {
    if (mutating.current) return; mutating.current = true; revision.current++; setBusy(true); setError('');
    const version = revision.current;
    try { const value = await request<{ following: boolean }>(`/threads/${thread}/notification-subscription`, { following: !following }, undefined, 'PATCH'); if (mounted.current && version === revision.current) setFollowing(value.following); }
    catch (reason) { if (mounted.current && version === revision.current) setError(failure(reason)); }
    finally { mutating.current = false; if (mounted.current) { setBusy(false); if (version === revision.current) void refresh.current(); } }
  }
  return <span className="notification-thread-toggle"><IconButton label={following ? 'Following thread' : 'Follow thread'} title={error || (following ? 'Stop following this thread' : 'Notify me about replies')} disabled={busy || following === undefined} onClick={() => void toggle()}>{following ? <Bell size={18} weight="fill"/> : <Bell size={18}/>}</IconButton>{error && <small role="alert">{error}</small>}</span>;
}

// Activity is durable; desktop banners are intentionally a bounded, best-effort hint.
export function useNotificationDelivery(workspace: string, currentChannel: string | undefined, onOpen: (item: NotificationItem) => void) {
  const cache = useWorkspaceQueryCache(workspace);
  const [count, setCount] = useState(0);
  const current = useRef({ channel: currentChannel, onOpen }); current.current = { channel: currentChannel, onOpen };
  useEffect(() => {
    setCount(0); if (!workspace) return;
    let active = true, baseline = true, generation = 0;
    const controller = new AbortController();
    const path = `/workspaces/${workspace}/notifications`;
    const seen = new Set<string>();
    const sound = createNotificationSound();
    const handles = new Map<string, Notification>(), connection = acquireRealtime();
    const close = () => { for (const handle of handles.values()) handle.close(); handles.clear(); };
    connection.on('disconnect', () => { generation++; baseline = true; close(); });
    const stop = subscribeUpdates('workspace', workspace, async () => {
      const version = generation;
      try {
        const page = await readWorkspaceQuery<NotificationActivity>(cache, path, controller.signal);
        if (!active || version !== generation) return;
        if (!Array.isArray(page?.items)) { cache?.invalidate(`/workspaces/${workspace}/notifications`); return; }
        sound.setEnabled(page.sound_enabled === true);
        setCount(page.unread_count);
        for (const [id, handle] of handles) if (!page.items.some(item => item.id === id && !item.read_at)) { handle.close(); handles.delete(id); }
        const fresh = page.items.filter(item => !seen.has(item.id));
        for (const item of page.items) seen.add(item.id);
        while (seen.size > 500) seen.delete(seen.values().next().value!);
        if (baseline) { baseline = false; return; }
        const desktop = typeof Notification !== 'undefined' && Notification.permission === 'granted';
        if (!desktop && !sound.ready) return;
        const attending = () => !document.hidden && document.hasFocus();
        const suppressed = (item: NotificationItem) => attending() && (current.current.channel === item.channel_id || current.current.channel === '*');
        const candidates = fresh.filter(item => !item.read_at && !item.silent && !suppressed(item)).slice(0, 3);
        let played = false;
        for (const item of candidates) {
          if (!active || version !== generation || suppressed(item)) break;
          const path = `/workspaces/${workspace}/notifications/${item.id}/claim`;
          if (sound.ready) {
            try {
              const result = await request<{ deliver: boolean }>(path, { channel: 'sound' });
              if (!active || version !== generation) return;
              if (result.deliver && !played && !suppressed(item)) {
                sound.play();
                played = true;
              }
            } catch (reason) {
              if (denied(reason)) throw reason;
              // A transient sound failure still allows the banner to be delivered.
            }
          }
          if (!active || version !== generation) return;
          if (!desktop || suppressed(item)) continue;
          const claim = await request<{ deliver: boolean; notification?: NotificationItem; preview_enabled?: boolean }>(path, {});
          if (!active || version !== generation || !claim.deliver || !claim.notification || suppressed(claim.notification)) continue;
          const value = claim.notification;
          const notification = new Notification(claim.preview_enabled ? `${value.author_name} · ${value.channel_kind === 'direct' ? value.channel_name : `#${value.channel_name}`}` : 'New activity in Space', { silent: true, body: claim.preview_enabled ? value.text || labels[value.kind] : 'Open Space to view your notification.', tag: `space:${workspace}:${value.id}` });
          handles.set(value.id, notification); notification.onclose = () => handles.delete(value.id);
          notification.onclick = () => { window.focus(); notification.close(); if (active) current.current.onOpen(value); };
          if (handles.size > 3) handles.values().next().value?.close();
        }
      } catch (reason) { if (denied(reason)) { cache?.invalidate(path); generation++; baseline = true; setCount(0); close(); } }
    }, () => { cache?.invalidate(path); generation++; baseline = true; setCount(0); close(); });
    return () => { active = false; generation++; controller.abort(); stop(); connection.release(); sound.setEnabled(false); close(); };
  }, [workspace, cache]);
  return count;
}
