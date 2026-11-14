import {DirectoryCreateChannel} from './create-channel-context.js';
import { ConversationMain } from '../chat/ConversationFrame.js';
import { sessionPath, conversationPath } from '@space/contracts';
import { ConversationHistory, usePublishedPath } from '../../shared/ui/conversation-location.js';
import { ChannelNotificationEditor } from './ChannelNotificationEditor.js';
import { ChannelConfirmation } from './ChannelDetails.js';
import { NotificationPreferences } from '../notifications/Notifications.js';
import { channelMenu, type NotificationPatch, type ChannelMenuDialog } from './channel-menu.js';
import { RenameSessionDialog } from '../agents/RenameSessionDialog.js';
import { AgentMessageLinkContext } from '@space/ui/agents';
import { AgentSessions } from '../agents/AgentSessions.js';
import { useAgentSessionList } from '../agents/useAgentSessionList.js';
import type { Snapshot } from '../../shared/ui/view-state.js';
import type { CodeChannelLocation, ConversationView } from '../chat/view-state.js';
import { usePersonalSections } from './SidebarSectionsProvider.js';
import { useStarredChannels } from './useStarredChannels.js';
import { useDirectMessageList } from '../direct-messages/DirectMessages.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { useWorkspaceUnread } from '../notifications/useWorkspaceUnread.js';
import { useContext, useLayoutEffect, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { DirectMessageSummary, AgentSessionReference, ChannelNotificationPreferences } from '@space/contracts';
import { Button, Dialog, ListRowSkeleton, toast } from '@space/ui/primitives';
import { WorkspaceSidebar } from '@space/ui/navigation';
import { motionTransition } from '@space/ui/motion';
import { type RichDocument } from '@space/ui/rich-text';
import { Headphones, CaretDown, Hash, Lock, Plus } from '@phosphor-icons/react';
import { listAll, request } from '../../shared/api/request.js';
import type { ChannelSummary as Channel } from '@space/contracts';
import type { Workspace } from '../workspace/workspace-types.js';
import type { Profile } from '../profile/profile-types.js';
import { type HubView } from '../workspace/collections/hub-view.js';
import { errorText } from '../../shared/api/error-text.js';
import { useDirectTyping } from '../chat/typing.js';
import { ChannelDetails } from './ChannelDetails.js';
import { useChannelPermissions } from './useChannelPermissions.js';
import { ChannelRoom } from '../chat/ChannelRoom.js';
import { ConversationLoading } from '../chat/ConversationLoading.js';
import { type UploadDrafts } from '../composer/useAttachmentUploads.js';

const sessionBatch = 5;
type ChannelView = { channels: Channel[]; selected: string; direct?: DirectMessageSummary; agentSession?: CodeChannelLocation; loaded: boolean; error: string };
const emptyChannelView: ChannelView = { channels: [], selected: '', loaded: false, error: '' };
export function WorkspaceChannels({ codeChannelView, onOpenOrigin, onReturnDirect, initialSession, onSessionRestored, viewForChannel, onRequestedChannelConsumed, shortcut, onShortcut, content, onContentClose, onDirectMessage, onNewDirectMessage, uploads, profile, workspace, workspaces, workspaceControl, width, onWidthChange, requestedChannel, mentionTarget, onMentionOpened, onVisit, searchOpen, onSearchClose, onSearchAvailabilityChange, drafts, onDraftChange, onForgetChannel }: { codeChannelView: Snapshot<CodeChannelLocation | undefined>; onOpenOrigin:(item:{channel_id:string;thread_id:string})=>void; onReturnDirect:(channel:string)=>void; initialSession?: CodeChannelLocation; onSessionRestored: () => void; viewForChannel:(id:string)=>Snapshot<ConversationView>; onRequestedChannelConsumed: () => void; shortcut?: HubView; onShortcut: (view: HubView) => void; content?: ReactNode; onContentClose: () => void; onDirectMessage: (id: string) => void; onNewDirectMessage: () => void; uploads: UploadDrafts; profile: Profile; workspace: string; workspaces: Workspace[]; workspaceControl: ReactNode; width: number; onWidthChange: (width: number) => void;  requestedChannel?: string; mentionTarget?: {channel_id:string;message_id:string;thread_id?:string;draftKey?:string}; onMentionOpened: () => void; onVisit: (channel?: Channel) => void; searchOpen: boolean; onSearchClose: () => void; onSearchAvailabilityChange: (available: boolean) => void; drafts: Record<string, RichDocument>; onDraftChange: (key: string, document: RichDocument) => void; onForgetChannel: (id: string) => void }) {
  const reduced = useReducedMotion();
  const [views, setViews] = useState(() => new Map<string, ChannelView>([[workspace, {...emptyChannelView, selected:(initialSession ?? codeChannelView.current)?.channel_id ?? '', agentSession: initialSession ?? codeChannelView.current} ]]));
  useEffect(() => { if (initialSession) onSessionRestored(); }, [initialSession, onSessionRestored]);
  const unread = useWorkspaceUnread(workspace);
  const typing = useDirectTyping(workspace, profile.id);
  const directs = useDirectMessageList(workspace);
  const sessions = useAgentSessionList(workspace);
  const [windowSize,setWindowSize] = useState({workspace,count:sessionBatch});
  const visibleCount = windowSize.workspace === workspace ? windowSize.count : sessionBatch;
  const [sidebarError,setSidebarError] = useState('');
  async function changeSession(id: string, change: {archived:boolean} | {target:string;side:'before'|'after'}) {
    const version = scope.current;
    setSidebarError('');
    try {
      await request(`/agent-sessions/${id}/sidebar`,change,undefined,'PATCH',undefined,profile.id);
      if ('archived' in change && version === scope.current) {
        if (change.archived) {
          updateView(view => view.agentSession?.id === id ? {...view,agentSession:undefined} : view);
          toast.success('Session archived',{id:`archive-session-${id}`,action:{label:'Undo',onClick:() => { void changeSession(id,{archived:false}); }}});
        } else toast.success('Session restored');
      }
      await invalidateUpdates('workspace',workspace);
    } catch (reason) {
      if (version === scope.current) setSidebarError(errorText(reason));
    }
  }
  const starred = useStarredChannels(workspace, undefined, profile.id);
  const personal = usePersonalSections();
  const assignmentByChannel = new Map(personal.assignments.map(item => [item.channel_id, item]));
  function sectionProps(id: string, defaultSection: 'channels' | 'direct') {
    return {
      defaultSection, customSectionId: assignmentByChannel.get(id)?.section_id,
      onMoveToSection: (section: string | null) => sectionAction(personal.move(id, section)),
    };
  }
  async function sectionAction(action: Promise<void>) {
    const version = scope.current;
    try { await action; }
    catch (reason) { if (version === scope.current) toast.error(errorText(reason)); }
  }
  const starredSessions = useStarredChannels(workspace, undefined, profile.id, 'starred-sessions');
  const [renameId,setRenameId] = useState<string>();
  const listedSessions = sessions.items.filter(item => !starredSessions.ids.includes(item.id));
  const agentSession = views.get(workspace)?.agentSession;
  useLayoutEffect(() => { codeChannelView.current = agentSession; }, [agentSession, codeChannelView]);
  const visibleSessions = listedSessions.slice(0,visibleCount);
  if (agentSession && listedSessions.length > visibleCount) {
    const activeIndex = listedSessions.findIndex(item => item.id === agentSession.id);
    if (activeIndex >= visibleCount) visibleSessions[visibleCount-1] = listedSessions[activeIndex]!;
  }
  const hiddenCount = Math.max(0,listedSessions.length-visibleCount);
  function showMoreSessions() {
    if (hiddenCount < sessionBatch && sessions.next_cursor) sessions.loadMore();
    setWindowSize({workspace,count:visibleCount+sessionBatch});
  }
  const sessionRows = [
    ...starredSessions.conversations.flatMap(item => item.session ? [{
      id:item.id, title:item.name, thread:item.session.origin_thread_id, agentName:item.session.agent_name, codeChannel:item.session.code_channel,
      section:'starred' as const, working:item.working, canRename:item.can_rename,
    }] : []),
    ...visibleSessions.map(item => ({
      id:item.id, title:item.title, thread:item.origin_thread_id, agentName:item.agent_name, codeChannel:item.code_channel,
      section:'sessions' as const, working:item.working, canRename:item.created_by===profile.id || item.owner_id===profile.id,
    })),
  ];
  function sessionActions(item: typeof sessionRows[number]) {
    const actions = [{label:'Archive session', select:() => void changeSession(item.id,{archived:true})}];
    if (item.section !== 'sessions') return {actions};
    return {actions,onMove:(target:string,side:'before'|'after') => changeSession(item.id,{target:target.slice('session:'.length),side})};
  }
  const renameTarget = sessionRows.find(item => item.id === renameId && item.canRename);
  const { channels, selected, loaded, error } = views.get(workspace) ?? emptyChannelView;
  const [detailsId, setDetailsId] = useState<string>();
  const detailsChannel = channels.find(item => item.id === detailsId && item.joined);
  const sidebarPermissions = useChannelPermissions(detailsChannel?.id, workspace);
  const [menuDialog, setMenuDialog] = useState<{ id:string; kind:ChannelMenuDialog }>();
  const [splitId, setSplitId] = useState<string>();
  const [showMuted, setShowMuted] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const split = channels.find(item => item.id === splitId);
  const target = channels.find(item => item.id === menuDialog?.id && item.joined);
  const byId = new Map(channels.map(item => [item.id,item]));
  useEffect(() => {
    const deadlines = channels.map(item => Date.parse(item.notification_preferences?.muted_until ?? '')).filter(end => end > Date.now());
    if (!deadlines.length) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0,Math.min(...deadlines) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [channels, clock]);
  const unreadById = new Map(unread.channels.map(item => [item.channel_id,item]));
  function huddleIcon(id:string) {
    if (byId.get(id)?.active_huddle || directById.get(id)?.active_huddle) return <span className="sidebar-huddle-icon" aria-label="Huddle in progress" role="img"><Headphones size={17} weight="bold"/></span>;
  }
  function badges(id: string) {
    const counts = unreadById.get(id);
    return {statusIcon:huddleIcon(id),unread:counts?.unread_count ?? 0,badgeCount:byId.get(id)?.notification_preferences?.badge_every_post ? counts?.unread_count ?? 0 : counts?.mention_count ?? 0};
  }
  function hiddenChannel(id: string) {
    const prefs = byId.get(id)?.notification_preferences;
    return !unreadById.get(id)?.mention_count && (prefs?.mode === 'none' || Date.parse(prefs?.muted_until ?? '') > Date.now());
  }
  const reportMenuError = (reason: unknown) => updateView(view => ({ ...view, error:errorText(reason) }));
  async function savePreferences(id: string, patch: NotificationPatch) {
    const preferences = await request<ChannelNotificationPreferences>(`/channels/${id}/notification-settings`, patch, undefined, 'PATCH', undefined, profile.id);
    channelMutation.current++;
    updateView(view => ({ ...view, channels:view.channels.map(item => item.id === id ? {...item,notification_preferences:preferences} : item) }));
  }
  function channelActions(c: { id: string; name: string; private: boolean; kind?: string }) {
    if (c.kind === 'direct') return {};
    const item = byId.get(c.id);
    if (!item) return {};
    const openSplit = () => setSplitId(c.id);
    return { onSplit:conversationPath(c.id) && window.self === window.top ? openSplit : undefined, actions:channelMenu(item, starred.ids.includes(c.id), {
      split:openSplit, dialog:kind => kind === 'details' ? setDetailsId(c.id) : setMenuDialog({id:c.id,kind}),
      copy:async (value, confirmation) => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(confirmation);
        } catch (reason) { reportMenuError(reason); }
      },
      star:() => { void starred.toggle(c.id, {...c,kind:'channel'}).catch(reportMenuError); },
      save:patch => { void savePreferences(c.id,patch).catch(reportMenuError); },
    }) };
  }
  const homeDirect = views.get(workspace)?.direct;
  const openMessage = useContext(AgentMessageLinkContext);
  const historyRestore = useContext(ConversationHistory);
  const origin = useRef<{
    workspace: string; session: AgentSessionReference; path: string; destination: string;
    link: HTMLAnchorElement; timeline: HTMLElement; scrollTop: number; linkTop: number; width: number;
    item: { channel_id: string; message_id: string };
  } | null>(null);
  const restorePosition = useRef(false);
  const retained = origin.current?.workspace === workspace ? origin.current : null;
  const renderedSession = agentSession ?? (retained && !content && !homeDirect && (selected === retained.item.channel_id || requestedChannel === retained.item.channel_id) ? retained.session : undefined);
  function followCitation(item: {channel_id: string; message_id: string}, link: HTMLAnchorElement) {
    const timeline = link.closest<HTMLElement>('.chat-timeline');
    const path = agentSession && sessionPath(agentSession.id);
    if (agentSession && path && path === location.pathname && timeline) {
      origin.current = { workspace, session: agentSession, path, destination: link.pathname, item, link, timeline,
        width: timeline.closest('main')?.clientWidth ?? timeline.clientWidth, scrollTop: timeline.scrollTop, linkTop: link.getBoundingClientRect().top - timeline.getBoundingClientRect().top };
    }
    openMessage?.(item, link);
  }
  useLayoutEffect(() => {
    if (!historyRestore) return;
    historyRestore.current = (from, to) => {
      const entry = origin.current;
      if (!entry || entry.workspace !== workspace || !entry.timeline.isConnected) return false;
      if (from === entry.destination && to === entry.path) {
        restorePosition.current = true;
        updateView(view => ({...view, agentSession:entry.session}));
        return true;
      }
      if (from === entry.path && to === entry.destination && openMessage) {
        openMessage(entry.item, entry.link);
        return true;
      }
      return false;
    };
    return () => { historyRestore.current = null; };
  }, [workspace, historyRestore, openMessage]);
  useLayoutEffect(() => {
    if (!restorePosition.current || !retained || retained.session.id !== agentSession?.id) return;
    restorePosition.current = false;
    const { timeline, link, scrollTop, linkTop } = retained;
    const restore = () => {
      timeline.scrollTop = scrollTop;
      if (link.isConnected) {
        timeline.scrollTop += link.getBoundingClientRect().top - timeline.getBoundingClientRect().top - linkTop;
        link.focus({preventScroll:true});
      }
    };
    restore();
    // History traversal and the virtual timeline both finish layout after popstate.
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [agentSession, retained]);
  const sourceButton = useRef<{session:string;channel:string;label:string} | null>(null);
  const [restoreSource, setRestoreSource] = useState<typeof sourceButton.current>(null);
  function closeToSource() {
    if (sourceButton.current?.session === agentSession?.id) setRestoreSource(sourceButton.current);
    sourceButton.current = null;
    closeSession();
    if (agentSession?.fromDirectInbox) onReturnDirect(agentSession.channel_id);
  }
  useEffect(() => {
    if (!restoreSource || agentSession || content || restoreSource.channel !== (homeDirect?.id ?? selected)) return;
    const main = document.getElementById('chat-messages');
    if (!main || main.querySelector('[aria-label="Thread"]')) return;
    main.focus({preventScroll:true});
    const focusSource = () => {
      const button = Array.from(main.querySelectorAll<HTMLButtonElement>('button[data-code-channel-id]')).find(item =>
        item.dataset.codeChannelId === restoreSource.session && (item.getAttribute('aria-label') ?? item.textContent) === restoreSource.label);
      if (!button || document.activeElement !== main) return false;
      button.focus({preventScroll:true});
      return true;
    };
    if (focusSource()) { setRestoreSource(null); return; }
    const observer = new MutationObserver(() => { if (focusSource()) setRestoreSource(null); });
    observer.observe(main, {childList:true,subtree:true});
    const deadline = window.setTimeout(() => setRestoreSource(null), 3000);
    return () => { observer.disconnect(); window.clearTimeout(deadline); };
  }, [restoreSource, agentSession, selected, homeDirect?.id, content]);
  function closeSession() {
    codeChannelView.current = undefined;
    origin.current = null;
    updateView(view => ({...view,agentSession:undefined}));
  }
  useEffect(() => {
    if (!shortcut && !requestedChannel && !mentionTarget) return;
    const target = origin.current?.item;
    if (shortcut || (requestedChannel && requestedChannel !== target?.channel_id) ||
        (mentionTarget && (mentionTarget.channel_id !== target?.channel_id || mentionTarget.message_id !== target.message_id))) origin.current = null;
    updateView(view => ({...view,agentSession:undefined}));
  }, [shortcut,requestedChannel,mentionTarget,workspace]);
  useEffect(() => { if(agentSession && document.activeElement !== origin.current?.link) document.getElementById('chat-messages')?.focus(); },[agentSession?.id]);
  const currentHomeDirect = useRef(homeDirect); currentHomeDirect.current = homeDirect;
  function updateView(change: (view: ChannelView) => ChannelView) {
    setViews(previous => new Map(previous).set(workspace, change(previous.get(workspace) ?? emptyChannelView)));
  }
  const latestRequestedChannel = useRef(requestedChannel), latestSelected = useRef(selected);
  latestRequestedChannel.current = requestedChannel; latestSelected.current = selected;
  const latestChannels = useRef(channels); latestChannels.current = channels;
  function forgetRevoked(next: Channel[]) {
    for (const previous of latestChannels.current) {
      if (previous.joined && !next.some(item => item.id === previous.id && item.joined)) onForgetChannel(previous.id);
    }
  }
  const scope = useRef(0);
  const channelMutation = useRef(0);
  const [name, setName] = useState(''), [isPrivate, setPrivate] = useState(false), [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false), [composeRequest, setComposeRequest] = useState(0);
  useEffect(() => {
    let active = true, initialized = false;
    scope.current++;
    setSidebarError(''); setRenameId(undefined); setDetailsId(undefined); setSplitId(undefined); setMenuDialog(undefined); setShowMuted(false);
    setName(''); setPrivate(false); setBusy(false); setCreateOpen(false); setComposeRequest(0);
    updateView(view => ({ ...view, error: '' }));
    async function load() {
      const version = channelMutation.current;
      try {
        const items = await listAll<Channel>(`/workspaces/${workspace}/channels`);
        if (!active) return;
        if (version !== channelMutation.current) { void load(); return; }
        forgetRevoked(items);
        let requestedDirect: DirectMessageSummary | undefined;
        if (latestRequestedChannel.current && !items.some(item => item.id === latestRequestedChannel.current)) {
          const requestedId = latestRequestedChannel.current;
          try { const requested = await request<DirectMessageSummary>(`/channels/${requestedId}`); if (active && latestRequestedChannel.current === requestedId && requested.kind === 'direct' && requested.workspace_id === workspace) requestedDirect = requested; } catch { /* Inaccessible links fall back to the workspace. */ }
          if (!active) return;
        }
        const ordered = items.sort((a, b) => Number(b.name === 'general') - Number(a.name === 'general') || a.name.localeCompare(b.name));
        const initial = ordered.find(c => c.id === latestRequestedChannel.current) ?? ordered.find(c => c.id === latestSelected.current) ?? ordered.find(c => c.joined) ?? ordered[0];
        updateView(view => ({ ...view, channels: ordered, selected: initial?.id ?? '', direct: requestedDirect ?? view.direct, loaded: true, error: '' }));
        if (!initialized) { initialized = true; onVisit(requestedDirect ?? currentHomeDirect.current ?? initial); }
      } catch (e) {
        if (!active) return;
        const denied = e instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(e.message);
        if (denied && currentHomeDirect.current) onForgetChannel(currentHomeDirect.current.id);
        updateView(view => ({ ...(denied ? { ...emptyChannelView, loaded: true } : view), error: errorText(e) }));
      }
    }
    const stop = subscribeUpdates('workspace', workspace, load, code => {
      active = false; forgetRevoked([]);
      if (currentHomeDirect.current) onForgetChannel(currentHomeDirect.current.id);
      updateView(() => ({ ...emptyChannelView, loaded: true, error: errorText(new Error(code)) }));
    });
    return () => { active = false; stop(); scope.current++; };
  }, [workspace]);
  useEffect(() => {
    if (!requestedChannel || !loaded) return;
    if (channels.some(channel => channel.id === requestedChannel)) { updateView(view => ({ ...view, selected: requestedChannel, direct: undefined })); setComposeRequest(0); onSearchClose(); onVisit(channels.find(channel => channel.id === requestedChannel)); onRequestedChannelConsumed(); return; }
    let active = true; const controller = new AbortController();
    void request<DirectMessageSummary>(`/channels/${requestedChannel}`, undefined, undefined, 'POST', controller.signal).then(dm => {
      if (!active) return;
      if (dm.kind === 'direct' && dm.workspace_id === workspace) { updateView(view => ({ ...view, direct: dm })); onVisit(dm); }
      onRequestedChannelConsumed();
    }).catch(reason => { if (active && reason?.name !== 'AbortError') { updateView(view => ({ ...view, error: errorText(reason) })); onRequestedChannelConsumed(); } });
    return () => { active = false; controller.abort(); };
  }, [requestedChannel, channels, loaded, workspace]);
  function channelChanged(updated: Channel) {
    channelMutation.current++;
    updateView(view => ({ ...view, channels: view.channels.map(item => item.id === updated.id ? { ...item, ...updated } : item) }));
  }
  function leftChannel(channel: Channel) {
    channelMutation.current++;
    onForgetChannel(channel.id);
    const remaining = channels.filter(item => item.id !== channel.id);
    const next = remaining.find(item => item.joined) ?? remaining[0];
    updateView(view => ({ ...view, channels: channel.private ? view.channels.filter(item => item.id !== channel.id) : view.channels.map(item => item.id === channel.id ? { ...item, joined: false } : item), selected: channel.private && view.selected === channel.id ? next?.id ?? '' : view.selected }));
    if (channel.private && selected === channel.id && !homeDirect && !agentSession && !content) onVisit(next);
  }
  async function create(event: FormEvent) {
    channelMutation.current++;
    event.preventDefault(); setBusy(true); updateView(view => ({ ...view, error: '' }));
    const version = scope.current;
    try {
      const channel = await request<Channel>(`/workspaces/${workspace}/channels`, { name, private: isPrivate });
      channelMutation.current++;
      updateView(view => ({ ...view, channels: [...view.channels, channel], selected: version === scope.current ? channel.id : view.selected, direct: version === scope.current ? undefined : view.direct }));
      if (version !== scope.current) return;
      if(shortcut==='directories')onContentClose();
      onVisit(channel); setName(''); setPrivate(false); setCreateOpen(false); onSearchClose();
    } catch (e) { updateView(view => ({ ...view, error: errorText(e) })); }
    finally { if (version === scope.current) setBusy(false); }
  }
  const channel = homeDirect ?? channels.find(c => c.id === selected);
  usePublishedPath(content || requestedChannel || !loaded ? undefined : agentSession ? sessionPath(agentSession.id) : !channel ? null : !channel.joined ? conversationPath(channel.id) : undefined);
  function forgetDirect(id: string, reason?: string) {
    if (currentHomeDirect.current?.id !== id) return;
    updateView(view => view.direct?.id === id ? { ...view, direct: undefined, error: reason ?? '' } : view);
    onVisit(channels.find(item => item.id === selected));
  }
  useEffect(() => {
    if (!homeDirect) return;
    const id = homeDirect.id; let active = true;
    const controller = new AbortController();
    const revoke = (reason: string) => { if (active) { onForgetChannel(id); forgetDirect(id, reason); } };
    const stop = subscribeUpdates('channel', id, async () => {
      try {
        const dm = await request<DirectMessageSummary>(`/channels/${id}`, undefined, undefined, 'POST', controller.signal);
        if (!active) return;
        if (dm.kind !== 'direct' || dm.workspace_id !== workspace) { revoke('This conversation is unavailable'); return; }
        updateView(view => view.direct?.id === id ? { ...view, direct: dm } : view);
      } catch (reason) {
        if (!active || (reason instanceof Error && reason.name === 'AbortError')) return;
        if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) revoke(errorText(reason));
        else updateView(view => ({ ...view, error: errorText(reason) }));
      }
    }, code => revoke(errorText(new Error(code))));
    return () => { active = false; controller.abort(); stop(); };
  }, [workspace, homeDirect?.id]);
  const closingDirect = useRef(false);
  async function closeHomeDirect() {
    if (!homeDirect || closingDirect.current) return;
    const id = homeDirect.id, version = scope.current;
    closingDirect.current = true;
    try {
      await request(`/channels/${id}/direct-message`, { hidden: true }, undefined, 'PATCH');
      if (version === scope.current) { forgetDirect(id); await directs.refresh(); }
    } catch (reason) { if (version === scope.current) updateView(view => ({ ...view, error: errorText(reason) })); }
    finally { closingDirect.current = false; }
  }
  useEffect(() => { onSearchAvailabilityChange(!agentSession && Boolean(channel?.joined)); return () => onSearchAvailabilityChange(false); }, [workspace, channel?.joined, agentSession?.id, onSearchAvailabilityChange]);
  async function join() {
    channelMutation.current++;
    if (!channel) return; setBusy(true); updateView(view => ({ ...view, error: '' }));
    const version = scope.current;
    try { await request(`/channels/${channel.id}/join`, {}); channelMutation.current++; updateView(view => ({ ...view, channels: view.channels.map(c => c.id === channel.id ? { ...c, joined: true } : c) })); }
    catch (e) { updateView(view => ({ ...view, error: errorText(e) })); }
    finally { if (version === scope.current) setBusy(false); }
  }
  const directById = new Map(directs.items.map(dm => [dm.id, dm]));
  function directAvatar(id: string) {
    const participants = directById.get(id)?.participants;
    const person = participants?.find(member => member.id !== profile.id) ?? participants?.[0];
    return { initials:person?.name.slice(0, 2).toUpperCase(), image:person?.image, online:person?.presence === 'active' };
  }
  return <DirectoryCreateChannel.Provider value={()=>setCreateOpen(true)}><div className="chat-layout" style={{ '--chat-sidebar-width': `${width}px` } as CSSProperties}>
    <div id="chat-conversations" className="chat-sidebar">
      <WorkspaceSidebar workspaceId={workspace} workspace={workspaces.find(w => w.id === workspace)?.name ?? 'Workspace'} width={width} onWidthChange={onWidthChange}
        loading={!loaded && !error} showEmptySections onNewMessage={onNewDirectMessage}
        selectedShortcut={shortcut} onThreads={() => onShortcut('threads')} onHuddles={() => onShortcut('huddles')} onDrafts={() => onShortcut('drafts')} onSaved={() => onShortcut('saved')} onDirectories={() => onShortcut('directories')}
        sessionBatchSize={sessionBatch}
        workspaceControl={workspaceControl}
        customSections={personal.sections}
        onCreateSection={personal.createSection}
        onToggleSection={(id, collapsed) => void sectionAction(personal.update(id, { collapsed }))}
        onRenameSection={id => personal.manageSection(id, 'rename')}
        onDeleteSection={id => personal.manageSection(id, 'delete')}
        channels={[
          ...starred.conversations.filter(c => showMuted || !hiddenChannel(c.id)).map(c => ({
            id:c.id, name:c.name, section:'starred' as const, ...channelActions(c), ...badges(c.id), private:c.private,
            ...sectionProps(c.id, c.kind === 'direct' ? 'direct' : 'channels'),
            ...(c.kind === 'direct' && directAvatar(c.id)), typing:c.kind === 'direct' && typing.has(c.id),
          })),
          ...channels.filter(c => !starred.ids.includes(c.id) && (showMuted || !hiddenChannel(c.id))).map(c => ({
            id:c.id, ...channelActions(c), name:c.archived_at ? `${c.name} (archived)` : c.name,
            private:c.private, ...badges(c.id), section:'channels' as const, ...(c.joined && sectionProps(c.id, 'channels')),
          })),
          ...sessionRows.map(item => ({ id:`session:${item.id}`, name:item.title, ...sessionActions(item), agentName:item.agentName, codeChannel:item.codeChannel,
            typing:item.working, section:item.section, onRename:item.canRename ? () => setRenameId(item.id) : undefined })),
          ...directs.items.filter(dm => !starred.ids.includes(dm.id)).map(dm => ({
            id:dm.id, name:dm.name, typing:typing.has(dm.id), section:'direct' as const,
            ...sectionProps(dm.id, 'direct'), ...directAvatar(dm.id), statusIcon:huddleIcon(dm.id), unread:unreadById.get(dm.id)?.unread_count ?? 0,
          })),
          ...personal.assignments.filter(item => item.kind === 'direct' && !starred.ids.includes(item.channel_id) && !directById.has(item.channel_id))
            .map(item => ({ id:item.channel_id, name:item.name, section:'direct' as const, typing:typing.has(item.channel_id),
              ...sectionProps(item.channel_id, 'direct'), unread:unreadById.get(item.channel_id)?.unread_count ?? 0 })),
        ]} selectedId={shortcut ? '' : agentSession ? `session:${agentSession.id}` : homeDirect?.id ?? selected}
        onSelect={id => { origin.current = null; onContentClose(); const session = sessions.items.find(item => `session:${item.id}` === id) ?? starredSessions.conversations.find(item=>`session:${item.id}`===id)?.session; if (session) { updateView(view => ({...view,agentSession:session})); onSearchClose(); return; } closeSession(); if (directById.has(id) || assignmentByChannel.get(id)?.kind === 'direct' || starred.conversations.some(c => c.id === id && c.kind === 'direct')) { const dm = directById.get(id); if (dm) { updateView(view => ({ ...view, direct: dm })); onVisit(dm); onSearchClose(); } else onDirectMessage(id); return; } updateView(view => ({ ...view, selected: id, direct: undefined })); onVisit(channels.find(channel => channel.id === id)); setComposeRequest(0); onSearchClose(); }} onCreateChannel={() => setCreateOpen(true)}
        sectionFooters={{channels:<>
          {!loaded && !error && <ListRowSkeleton label="Loading conversations…" />}
          {channels.some(c => hiddenChannel(c.id)) && <button className="sp-sidebar-section-toggle" onClick={() => setShowMuted(!showMuted)}>{showMuted ? 'Hide muted channels' : 'Show muted channels'}</button>}
        </>,starred:<>
          {starredSessions.next&&<Button size="sm" onClick={starredSessions.loadMore}>More starred sessions</Button>}
          {starredSessions.hasPrevious&&<Button size="sm" onClick={starredSessions.first}>First starred sessions</Button>}
        </>,sessions:<>
          {sessions.loading && !sessions.items.length && <ListRowSkeleton label="Loading sessions…" />}
          {sidebarError && <p className="agent-session-sidebar-notice" role="alert">{sidebarError}</p>}
          {sessions.error && <p className="agent-session-sidebar-notice" role="alert">{sessions.error} {!sessions.revoked && <Button size="sm" onClick={()=>void sessions.refresh()}>Retry sessions</Button>}</p>}
          {(hiddenCount > 0 || sessions.next_cursor) && <div className="agent-session-disclosure">
            <button type="button" disabled={sessions.loading} onClick={showMoreSessions}>
              <CaretDown size={13} aria-hidden="true"/>{sessions.loading ? 'Loading…' : 'Show more'}
            </button>
          </div>}
        </>}}
        footer={starred.next ? <Button size="sm" onClick={starred.loadMore}>More starred conversations</Button> : starred.hasPrevious ? <Button size="sm" onClick={starred.first}>First starred conversations</Button> : false} />
      {personal.error && <p className="chat-sidebar-loading" role="alert">Sidebar sections: {personal.error}</p>}
      {unread.error && <p className="chat-sidebar-loading" role="status">{unread.error}</p>}
      {error && channel?.joined && <p role="alert">{error}</p>}
    </div>
    {renderedSession && !content && <ConversationMain retainContents primary={!!agentSession} inert={!agentSession} aria-hidden={!agentSession || undefined} style={!agentSession ? {width:retained?.width} : undefined} id={agentSession ? "chat-messages" : undefined} tabIndex={-1} className={agentSession ? "chat-channel" : "chat-channel chat-session-retained"} aria-label="Agent session"><AgentMessageLinkContext.Provider value={openMessage ? followCitation : null}><AgentSessions primary={!!agentSession} agentName={renderedSession.agent_name} key={renderedSession.id} thread={renderedSession.origin_thread_id} channel={renderedSession.channel_id} initialSessionId={renderedSession.id} initialArtifact={agentSession?.artifact} channelName={byId.get(renderedSession.channel_id)?.name} viewerId={profile.id} archived={renderedSession.channel_archived} drafts={drafts} onDraftChange={onDraftChange} attempt={uploads.attempt} acknowledged={uploads.acknowledged} uploads={uploads} onAccepted={uploads.sent} onBack={()=>{closeSession();onOpenOrigin({channel_id:renderedSession.channel_id,thread_id:renderedSession.origin_thread_id});}} onClose={closeToSource} onAccessLost={()=>{origin.current=null;const key=`session:${renderedSession.channel_id}:${renderedSession.id}`;delete drafts[key];onDraftChange(key,{ops:[]});closeSession();void sessions.refresh();}}/></AgentMessageLinkContext.Provider></ConversationMain>}
    {content ?? (agentSession ? null : !loaded && !error ? <ConversationLoading label="Loading workspace" /> : channel?.joined ? <ChannelRoom onOpenCodeChannel={(thread,id,artifact)=>{
      origin.current=null;
      const trigger=document.activeElement;
      sourceButton.current=trigger instanceof HTMLButtonElement && trigger.dataset.codeChannelId===id ? {session:id,channel:channel.id,label:trigger.getAttribute('aria-label') ?? trigger.textContent ?? ''} : null;
      const known=sessions.items.find(item=>item.id===id);
      updateView(view=>({...view,agentSession:{id,origin_thread_id:thread,channel_id:channel.id,channel_archived:!!channel.archived_at,agent_name:known?.agent_name ?? '',artifact}}));
    }} viewState={viewForChannel(channel.id)} readState={unread.channels.find(item => item.channel_id === channel.id)} editDraftKey={mentionTarget?.channel_id === channel.id ? mentionTarget.draftKey : undefined} requestedThread={mentionTarget?.channel_id === channel.id ? mentionTarget.thread_id : undefined} mentionTarget={mentionTarget?.channel_id === channel.id ? mentionTarget.message_id : undefined} onMentionOpened={onMentionOpened} key={channel.id} uploads={uploads} profile={profile} channel={channel} onChannelChange={updated => homeDirect ? updateView(view => ({ ...view, direct: updated as DirectMessageSummary })) : channelChanged(updated)} onCloseDirect={homeDirect ? () => void closeHomeDirect() : undefined} onLeft={() => leftChannel(channel)} drafts={drafts} onDraftChange={onDraftChange} onAccessLost={() => { onForgetChannel(channel.id); if (homeDirect) forgetDirect(channel.id, 'This conversation is unavailable'); }} searchOpen={searchOpen} onSearchClose={onSearchClose} composeRequest={composeRequest} /> : <motion.main initial={reduced ? false : { opacity: .65 }} animate={{ opacity: 1 }} transition={motionTransition(reduced)} id="chat-messages" tabIndex={-1} className="chat-empty"><div className="chat-empty-icon">{channel?.private ? <Lock size={32} /> : <Hash size={32} />}</div><h1>{channel ? channel.name : 'A place for every conversation'}</h1><p>{channel ? channel.archived_at ? 'Join this archived channel to read its message history.' : 'Join this channel to read and send messages with your team.' : loaded ? 'Create your first channel and bring your team together.' : 'Loading your channels…'}</p>{channel ? <Button variant="primary" loading={busy} onClick={() => void join()}>Join channel</Button> : loaded && <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={17} /> Create channel</Button>}{error && <p role="alert">{error}</p>}</motion.main>)}
    {split && <aside className="space-channel-split" aria-label={`Split view of #${split.name}`}>
      <header><strong>#{split.name}</strong><Button size="sm" aria-label="Close split view" onClick={() => setSplitId(undefined)}>Close</Button></header>
      <iframe key={split.id} title={`Conversation in #${split.name}`} src={conversationPath(split.id) + '?view=split'} />
    </aside>}
    {target && menuDialog?.kind === 'default' && <NotificationPreferences workspace={workspace} onClose={() => { setMenuDialog(undefined); void invalidateUpdates('workspace',workspace); }}/>}
    {target && menuDialog?.kind === 'advanced' && <ChannelNotificationEditor key={target.id} channel={target} onClose={() => setMenuDialog(undefined)} onSave={patch => savePreferences(target.id,patch)}/>}
    {target && menuDialog?.kind === 'leave' && <ChannelConfirmation title={`Leave #${target.name}?`} label="Leave channel"
      description={target.private ? 'You’ll need an invitation to rejoin this private channel.' : 'You can rejoin this public channel at any time.'}
      onClose={() => setMenuDialog(undefined)} onConfirm={async () => {
        await request(`/channels/${target.id}/members/${profile.id}`, undefined, undefined, 'DELETE');
        return `You left #${target.name}`;
      }}
      onDone={() => leftChannel(target)}/>}
    {detailsChannel && <ChannelDetails open channel={detailsChannel} viewer={profile.id} permissions={sidebarPermissions.snapshot}
      permissionsPending={!sidebarPermissions.snapshot} onClose={() => setDetailsId(undefined)} onChange={channelChanged}
      onLeft={() => { leftChannel(detailsChannel); setDetailsId(undefined); }} />}
    {renameTarget && <RenameSessionDialog key={renameTarget.id} id={renameTarget.id} title={renameTarget.title}
      workspace={workspace} thread={renameTarget.thread} viewerId={profile.id} onClose={()=>setRenameId(undefined)}/>}
    <Dialog open={createOpen} title="Create a channel" onClose={() => setCreateOpen(false)}><form className="chat-form" onSubmit={create}><p>Channels bring the right people and conversations together.</p><label>Channel name<input maxLength={80} placeholder="e.g. product" value={name} required onChange={e => setName(e.target.value)} /></label><label className="chat-checkbox"><input type="checkbox" checked={isPrivate} onChange={e => setPrivate(e.target.checked)} /><span>Make private<small>Only added members can read and send messages.</small></span></label>{error && <p role="alert">{error}</p>}<div className="chat-form-actions"><Button disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</Button><Button variant="primary" type="submit" loading={busy}>Create channel</Button></div></form></Dialog>
  </div></DirectoryCreateChannel.Provider>;
}
