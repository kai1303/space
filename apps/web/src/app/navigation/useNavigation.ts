import { createWorkspaceViewState, conversationView } from './destination-state.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { request } from '../../shared/api/request.js';
import type { ChannelSummary as Channel } from '@space/contracts';
import type { Workspace } from '../../features/workspace/workspace-types.js';
import { homeShortcuts, type HubView } from '../../features/workspace/collections/hub-view.js';
import { errorText } from '../../shared/api/error-text.js';

type ConversationVisit = { workspace: string; channel?: string; label: string; direct?: boolean; inbox?: boolean };
export function useNavigation(workspaces: Workspace[], workspace: string, setWorkspace: (id: string) => void) {
  const [mentionTarget, setMentionTarget] = useState<{channel_id:string;message_id:string;thread_id?:string}>();
  const [membersOpen, setMembersOpen] = useState(false), [connection, setConnection] = useState<string>();
  const pageViews=useMemo(createWorkspaceViewState,[workspace]);
  const viewForChannel=(id:string)=>conversationView(pageViews.rooms,id);
  const [hubView, setHubView] = useState<HubView>();
  const [todoTarget, setTodoTarget] = useState<{workspace:string; id:string}>();
  const pendingSearch = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  function navigateHub(view: HubView, todoId?: string) {
    setTodoTarget(view === 'todos' && todoId ? {workspace, id:todoId} : undefined);
    pendingSearch.current = false; mentionNavigation.current++; setHubView(view); setActivityOpen(false); setDirectOpen(false); setDirectCompose(0); setSearchOpen(false); }
  function openChannel(id: string) { setHubView(undefined); setActivityOpen(false); setDirectOpen(false); setRequestedChannel(id); setSearchOpen(false); }
  function openCollection(item: {channel_id:string;message_id?:string;thread_id?:string}) {
    if (item.message_id) void openMention({channel_id:item.channel_id,message_id:item.message_id});
    else if(item.thread_id) void openMention({channel_id:item.channel_id,message_id:'',thread_id:item.thread_id});
    else void openMention({channel_id:item.channel_id,message_id:''});
  }
  const [activityOpen, setActivityOpen] = useState(false);
  const [directOpen, setDirectOpen] = useState(false), [directId, setDirectId] = useState<string>();
  const [directCompose, setDirectCompose] = useState(0);
  const lastHomeChannel = useRef<string | undefined>(undefined);
  const [navigationError, setNavigationError] = useState('');
  const mentionNavigation = useRef(0);
  async function openMention(item: {channel_id:string;message_id:string;thread_id?:string;channel_kind?:'channel'|'direct'}) {
    const attempt = ++mentionNavigation.current;
    try {
      // Activity can mention a public channel before joining; discovery renders its join screen.
      const destination = item.channel_kind === 'channel' ? {id:item.channel_id,kind:'channel'} : await request<Channel>(`/channels/${item.channel_id}`);
      if (attempt !== mentionNavigation.current) return;
      if ('workspace_id' in destination && destination.workspace_id && destination.workspace_id !== workspace) changeWorkspace(destination.workspace_id);
      setNavigationError(''); setHubView(undefined); setActivityOpen(false); setDirectCompose(0); setSearchOpen(false);
      setDirectOpen(destination.kind === 'direct');
      setDirectId(destination.kind === 'direct' ? destination.id : undefined);
      setRequestedChannel(destination.kind === 'direct' ? undefined : destination.id);
      setMentionTarget(item);
    } catch (reason) { if (attempt === mentionNavigation.current) setNavigationError(errorText(reason)); }
  }
  function openDirect(id: string | undefined = directId) { setHubView(undefined); setActivityOpen(false); mentionNavigation.current++; setDirectCompose(0); setDirectId(id); setDirectOpen(true); setSearchOpen(false); }
  function newDirect() { setHubView(undefined); setActivityOpen(false); setDirectId(undefined); setDirectCompose(value => value + 1); setDirectOpen(true); setSearchOpen(false); }
  function openHome() { pendingSearch.current = false; setHubView(undefined); setActivityOpen(false); mentionNavigation.current++; setDirectCompose(0); setRequestedChannel(lastHomeChannel.current); setDirectOpen(false); setSearchOpen(false); }
  const [searchOpen, setSearchOpen] = useState(false);
  const [canSearch, setCanSearch] = useState(false);
  const [requestedChannel, setRequestedChannel] = useState<string | undefined>(() => new URLSearchParams(window.location.search).get('channel') ?? undefined);
  useEffect(() => { if (pendingSearch.current && canSearch && !hubView && !activityOpen && !requestedChannel) { pendingSearch.current = false; setSearchOpen(true); } }, [canSearch, hubView, activityOpen, requestedChannel]);
  const [navigation, setNavigation] = useState<{ entries: ConversationVisit[]; index: number }>({ entries: [], index: -1 });
  function changeWorkspace(id: string) { setConnection(undefined); setHubView(undefined); setSettingsOpen(false); setActivityOpen(false); mentionNavigation.current++;
    setCanSearch(false); setDirectOpen(false); setDirectId(undefined); setDirectCompose(0); lastHomeChannel.current = undefined; setRequestedChannel(undefined); setWorkspace(id); setSearchOpen(false); setMembersOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.chat-workspace-switcher>summary')?.focus());
  }
  function visit(channel?: Channel) {
    if (channel?.kind === 'direct') setDirectId(channel.id);
    if (channel && !directOpen) lastHomeChannel.current = channel.id;
    setRequestedChannel(undefined);
    const entry = { workspace, channel: channel?.id, direct: channel?.kind === 'direct', inbox: directOpen, label: channel ? `${channel.kind === 'direct' ? '' : '#'}${channel.name} · ${workspaces.find(item => item.id === workspace)?.name ?? 'Workspace'}` : workspaces.find(item => item.id === workspace)?.name ?? 'Workspace' };
    setNavigation(previous => {
      const current = previous.entries[previous.index];
      if (current?.workspace === entry.workspace && current.channel === entry.channel && current.inbox === entry.inbox) return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), entry];
      return { entries, index: entries.length - 1 };
    });
  }
  function travel(index: number) { setHubView(undefined); setActivityOpen(false);
    setDirectCompose(0);
    const entry = navigation.entries[index];
    if (!entry || index === navigation.index) return;
    setSearchOpen(false); setMembersOpen(false);
    setDirectOpen(!!entry.inbox); setDirectId(entry.inbox ? entry.channel : undefined); setRequestedChannel(entry.inbox ? undefined : entry.channel); setWorkspace(entry.workspace);
    setNavigation(previous => ({ ...previous, index }));
  }
  const destination=hubView&&!homeShortcuts.has(hubView)?hubView==='spacebot'?'Spacebot':hubView:activityOpen?'Activity':directOpen?'DMs':'Home';
  return { mentionTarget, setMentionTarget, membersOpen, setMembersOpen, connection, setConnection, pageViews, viewForChannel, hubView, initialTodoId:todoTarget?.workspace === workspace ? todoTarget.id : undefined, setHubView, pendingSearch, settingsOpen, setSettingsOpen, navigateHub, openChannel, openCollection, activityOpen, setActivityOpen, directOpen, directId, directCompose, lastHomeChannel, navigationError, mentionNavigation, openMention, openDirect, newDirect, openHome, searchOpen, setSearchOpen, canSearch, setCanSearch, requestedChannel, setRequestedChannel, navigation, changeWorkspace, visit, travel, destination };
}
