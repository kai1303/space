import { Notifications, ThreadNotificationToggle, useNotificationDelivery } from './Notifications.js';
import { DirectMessages, useDirectMessageList } from './DirectMessages.js';
import { ConversationHeader, ConversationComposer, ConversationMessage, ConversationReplyDivider } from './ThreadConversation.js';
import { AgentSessions } from './AgentSessions.js';
import { TypingIndicator,useTypingPublisher } from './typing.js';
import { SocketSession } from './SocketSession.js';
import { acquireRealtime } from './socket-session.js';
import { subscribeUpdates } from './live-updates.js';
import { MentionInbox, MentionDetails, useMentionSearch } from "./Mentions.js";
import { NavigatorSettings, NavigatorSuggestions, agentMention } from './Navigator.js';
import { MessageTimeline, type TimelineHandle } from './MessageTimeline.js';
import { useMessageHistory } from './useMessageHistory.js';
import { useWorkspaceUnread } from './useWorkspaceUnread.js';
import { useChannelRead } from './useChannelRead.js';
import { AssetAttachments } from './AssetAttachments.js';
import { ChannelFiles } from './ChannelFiles.js';
import { ChannelMemory } from './ChannelMemory.js';
import { SourceMessage } from './SourceMessage.js';
import { AgentMessageBody, readAgentResponse } from './AgentMessageBody.js';
import { AgentResponse } from '@space/ui';
import { AgentTaskCard, taskEventStatus } from './AgentTaskWorkspace.js';
import { WorkspaceMembers } from './WorkspaceMembers.js';
import { ChannelDetails } from './ChannelDetails.js';
import { useEffect, useMemo, useRef, useState, useId, type CSSProperties, type FormEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ChannelUnread, MentionReference, NavigatorCandidate, ChatEvent, ChatHistory, ChatMessage, ChannelSummary, DirectMessageSummary } from '@space/contracts';
import { AgentApproval, Avatar, Button, Dialog, IconButton, Message, RichComposer, RichContent, WorkspaceSearch, WorkspaceSidebar, SidePanel, Reveal, motionTransition, searchMessages, useMessageArrivals, type Attachment, type RichDocument } from '@space/ui';
import { Archive, ArrowLeft, BookOpen, ChatCircle, Hash, Lock, MagnifyingGlass, Paperclip, Plus, Robot, Sparkle, Users, X } from '@phosphor-icons/react';
import { command, listAll, mergeEvents, messageSender, request, type MessageAttempt } from './chat-client.js';
import { uploadAsset, type AssetConfig } from './assets.js';
import { authClient } from './auth-client.js';
import { AuthScreen } from './AuthScreen.js';
import { ChatShell, WorkspacePicker } from './ChatShell.js';
import './chat.css';

type Workspace = { id: string; name: string };
type Channel = ChannelSummary;
type ChannelView = { channels: Channel[]; selected: string; loaded: boolean; error: string };
const emptyChannelView: ChannelView = { channels: [], selected: '', loaded: false, error: '' };
type Profile = { id: string; display_name: string };
type ConversationVisit = { workspace: string; channel?: string; label: string; direct?: boolean };
type UploadDrafts = {
  enabled: boolean;
  attempt: (key: string) => MessageAttempt;
  sent: (key: string, document: RichDocument, files: Attachment[]) => void;
  drafts: Record<string, Attachment[]>;
  acknowledged: Record<string, RichDocument>;
  change: (key: string, channel: string, files: Attachment[]) => void;
  retry: (key: string, channel: string, id: string) => void;
};
const errorText = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Something went wrong';

export function Chat() {
  useEffect(() => { document.title = 'Space — Chat'; }, []);
  const { data: session, isPending, error, refetch } = authClient.useSession();
  useEffect(() => {
    const expired = () => { void refetch(); };
    window.addEventListener('space:session-expired', expired);
    return () => window.removeEventListener('space:session-expired', expired);
  }, [refetch]);
  if (isPending) return <main className="chat-login"><p role="status">Opening your workspace…</p></main>;
  if (error) return <main className="chat-login"><div><p role="alert">Cannot check your session. Please try again.</p><Button onClick={() => void refetch()}>Try again</Button></div></main>;
  if (!session) return <AuthScreen />;
  return <SocketSession key={`${session.user.id}:${session.session.id}`}><ChatWorkspace profile={{ id: session.user.id, display_name: session.user.name }} /></SocketSession>;
}
function ChatWorkspace({ profile: initialProfile }: { profile: Profile }) {
  const [profile, setProfile] = useState(initialProfile);
  const [mentionTarget, setMentionTarget] = useState<{channel_id:string;message_id:string}>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]), [workspace, setWorkspace] = useState('');
  const [error, setError] = useState('');
  const [membersOpen, setMembersOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [directOpen, setDirectOpen] = useState(false), [directId, setDirectId] = useState<string>();
  const [directCompose, setDirectCompose] = useState(0);
  const lastHomeChannel = useRef<string | undefined>(undefined);
  const [navigationError, setNavigationError] = useState('');
  const mentionNavigation = useRef(0);
  async function openMention(item: {channel_id:string;message_id:string}) {
    const attempt = ++mentionNavigation.current;
    try {
      const destination = await request<Channel>(`/channels/${item.channel_id}`);
      if (attempt !== mentionNavigation.current) return;
      setNavigationError(''); setActivityOpen(false); setDirectCompose(0); setSearchOpen(false);
      setDirectOpen(destination.kind === 'direct');
      setDirectId(destination.kind === 'direct' ? destination.id : undefined);
      setRequestedChannel(destination.kind === 'direct' ? undefined : destination.id);
      setMentionTarget(item);
    } catch (reason) { if (attempt === mentionNavigation.current) setNavigationError(errorText(reason)); }
  }
  function openDirect(id?: string) { setActivityOpen(false); mentionNavigation.current++; setDirectCompose(0); setDirectId(id); setDirectOpen(true); setSearchOpen(false); }
  function newDirect() { setActivityOpen(false); setDirectId(undefined); setDirectCompose(value => value + 1); setDirectOpen(true); setSearchOpen(false); }
  function openHome() { setActivityOpen(false); mentionNavigation.current++; setDirectCompose(0); setRequestedChannel(lastHomeChannel.current); setDirectOpen(false); setSearchOpen(false); }
  const [searchOpen, setSearchOpen] = useState(false);
  const [canSearch, setCanSearch] = useState(false);
  // Captured widths track about 24% of the workspace after its 70px rail and 4px frame.
  const [sidebarRatio, setSidebarRatio] = useState(.24);
  const [layoutWidth, setLayoutWidth] = useState(() => Math.max(1, window.innerWidth - 74));
  const sidebarWidth = Math.max(180, Math.min(450, Math.round(layoutWidth * sidebarRatio)));
  const setSidebarWidth = (width: number) => setSidebarRatio(width / layoutWidth);
  useEffect(() => {
    const resize = () => setLayoutWidth(Math.max(1, window.innerWidth - 74));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const [requestedChannel, setRequestedChannel] = useState<string | undefined>(() => new URLSearchParams(window.location.search).get('channel') ?? undefined);
  const [navigation, setNavigation] = useState<{ entries: ConversationVisit[]; index: number }>({ entries: [], index: -1 });
  function changeWorkspace(id: string) { setActivityOpen(false); mentionNavigation.current++;
    setCanSearch(false); setDirectOpen(false); setDirectId(undefined); setDirectCompose(0); lastHomeChannel.current = undefined; setRequestedChannel(undefined); setWorkspace(id); setSearchOpen(false); setMembersOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.chat-workspace-switcher>summary')?.focus());
  }
  function visit(channel?: Channel) {
    if (channel && channel.kind !== 'direct') lastHomeChannel.current = channel.id;
    setRequestedChannel(undefined);
    const entry = { workspace, channel: channel?.id, direct: channel?.kind === 'direct', label: channel ? `${channel.kind === 'direct' ? '' : '#'}${channel.name} · ${workspaces.find(item => item.id === workspace)?.name ?? 'Workspace'}` : workspaces.find(item => item.id === workspace)?.name ?? 'Workspace' };
    setNavigation(previous => {
      const current = previous.entries[previous.index];
      if (current?.workspace === entry.workspace && current.channel === entry.channel) return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), entry];
      return { entries, index: entries.length - 1 };
    });
  }
  function travel(index: number) { setActivityOpen(false);
    setDirectCompose(0);
    const entry = navigation.entries[index];
    if (!entry || index === navigation.index) return;
    setSearchOpen(false); setMembersOpen(false);
    setDirectOpen(!!entry.direct); setDirectId(entry.direct ? entry.channel : undefined); setRequestedChannel(entry.direct ? undefined : entry.channel); setWorkspace(entry.workspace);
    setNavigation(previous => ({ ...previous, index }));
  }
  const notificationCount = useNotificationDelivery(workspace, activityOpen ? '*' : navigation.entries[navigation.index]?.channel, item => void openMention(item));
  const draftState = useRef<Record<string, RichDocument>>({});
  function saveDraft(key: string, document: RichDocument) {
    draftState.current[key] = document;
  }
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, Attachment[]>>({});
  const [acknowledgedDrafts, setAcknowledgedDrafts] = useState<Record<string, RichDocument>>({});
  const attachmentState = useRef(attachmentDrafts);
  const uploadJobs = useRef(new Map<string, { key: string; controller: AbortController }>());
  const messageAttempts = useRef(new Map<string, MessageAttempt>());
  const [assetsEnabled, setAssetsEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void request<AssetConfig>('/assets/config').then(config => { if (active) setAssetsEnabled(config.enabled === true); }).catch(() => {});
    return () => { active = false; for (const job of uploadJobs.current.values()) job.controller.abort(); uploadJobs.current.clear(); messageAttempts.current.clear(); };
  }, []);
  function updateAttachments(key: string, change: (files: Attachment[]) => Attachment[]) {
    attachmentState.current = { ...attachmentState.current, [key]: change(attachmentState.current[key] ?? []) };
    setAttachmentDrafts(attachmentState.current);
  }
  function startUpload(key: string, channel: string, attachment: Attachment) {
    if (!attachment.file || uploadJobs.current.has(attachment.id)) return;
    const job = { key, controller: new AbortController() };
    uploadJobs.current.set(attachment.id, job);
    const update = (change: (file: Attachment) => Attachment) => {
      if (uploadJobs.current.get(attachment.id) === job)
        updateAttachments(key, files => files.map(file => file.id === attachment.id ? change(file) : file));
    };
    update(file => ({ ...file, status: 'uploading', progress: 0, error: undefined }));
    void uploadAsset(channel, attachment.file, progress => update(file => ({ ...file, progress })), job.controller.signal)
      .then(asset => update(() => ({ ...asset, status: 'ready' })))
      .catch(error => update(file => ({ ...file, status: 'error', error: errorText(error) })))
      .finally(() => { if (uploadJobs.current.get(attachment.id) === job) uploadJobs.current.delete(attachment.id); });
  }
  function changeAttachments(key: string, channel: string, files: Attachment[]) {
    for (const [id, job] of uploadJobs.current) if (job.key === key && !files.some(file => file.id === id)) {
      uploadJobs.current.delete(id); job.controller.abort();
    }
    updateAttachments(key, () => files);
    for (const file of files) if (file.status === 'uploading') startUpload(key, channel, file);
  }
  const uploads: UploadDrafts = { enabled: assetsEnabled, attempt: key => {
    let state = messageAttempts.current.get(key);
    if (!state) { state = {}; messageAttempts.current.set(key, state); }
    return state;
  }, sent: (key, document, files) => {
    if (!messageAttempts.current.has(key)) return;
    setAcknowledgedDrafts(old => ({ ...old, [key]: document }));
    const sentIds = new Set(files.map(file => file.id));
    updateAttachments(key, current => current.filter(file => !sentIds.has(file.id)));
    if (JSON.stringify(draftState.current[key]) === JSON.stringify(document)) saveDraft(key, { ops: [] });
  }, acknowledged: acknowledgedDrafts, drafts: attachmentDrafts, change: changeAttachments, retry: (key, channel, id) => {
    const file = attachmentState.current[key]?.find(file => file.id === id);
    if (file?.status === 'error') startUpload(key, channel, file);
  } };
  function forgetChannel(id: string) {
    const belongs = (key: string) => key === id || key.startsWith(`thread:${id}:`);
    setAcknowledgedDrafts(old => Object.fromEntries(Object.entries(old).filter(([key]) => !belongs(key))));
    for (const key of messageAttempts.current.keys()) if (belongs(key)) messageAttempts.current.delete(key);
    draftState.current = Object.fromEntries(Object.entries(draftState.current).filter(([key]) => !belongs(key)));
    for (const [id, job] of uploadJobs.current) if (belongs(job.key)) { uploadJobs.current.delete(id); job.controller.abort(); }
    attachmentState.current = Object.fromEntries(Object.entries(attachmentState.current).filter(([key]) => !belongs(key)));
    setAttachmentDrafts(attachmentState.current);
  }
  const [loaded, setLoaded] = useState(false), [workspaceName, setWorkspaceName] = useState(''), [creating, setCreating] = useState(false);
  async function createWorkspace(event: FormEvent) {
    event.preventDefault(); setCreating(true); setError('');
    try { const created = await request<Workspace>('/workspaces', { name: workspaceName }); setWorkspaces(items => [...items, created]); setWorkspace(created.id); }
    catch (e) { setError(errorText(e)); } finally { setCreating(false); }
  }
  useEffect(() => {
    let active = true;
    void listAll<Workspace>('/workspaces').then(items => { if (active) { const requested = new URLSearchParams(window.location.search).get('workspace'); setWorkspaces(items); setWorkspace(items.find(item => item.id === requested)?.id ?? items[0]?.id ?? ''); setLoaded(true); } }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, []);
  const selectedWorkspace = workspaces.find(item => item.id === workspace);
  const recent = navigation.entries.map((entry, index) => ({ ...entry, index })).reverse().filter((entry, index, entries) => entries.findIndex(other => other.workspace === entry.workspace && other.channel === entry.channel) === index);
  return <ChatShell onActivity={workspace ? () => { mentionNavigation.current++; setActivityOpen(true); setSearchOpen(false); setCanSearch(false); } : undefined} activityActive={activityOpen} notificationCount={notificationCount} onHome={openHome} onDirectMessages={workspace ? () => openDirect() : undefined} directMessagesActive={directOpen && !activityOpen} activity={workspace ? <MentionInbox key={workspace} workspace={workspace} onOpen={item => void openMention(item)} /> : undefined} name={selectedWorkspace?.name ?? 'Space'} user={profile.display_name} userId={profile.id} onNameChange={name => setProfile(old => old.display_name === name ? old : { ...old, display_name: name })} workspaces={workspaces} workspace={workspace} onWorkspaceChange={workspaces.length ? changeWorkspace : undefined} sidebarWidth={sidebarWidth} onBack={navigation.index > 0 ? () => travel(navigation.index - 1) : undefined} onForward={navigation.index < navigation.entries.length - 1 ? () => travel(navigation.index + 1) : undefined} history={recent.map(entry => ({ label: entry.label, onSelect: () => travel(entry.index) }))} onMembers={workspace ? () => setMembersOpen(true) : undefined} onSearch={canSearch ? () => setSearchOpen(true) : undefined}>
    {workspace && <WorkspaceMembers key={`members:${workspace}`} workspace={workspace} viewer={profile.id} open={membersOpen} onClose={() => setMembersOpen(false)} />}
    {error && <p role="alert">{error}</p>}
    {navigationError && <p role="alert">{navigationError}</p>}
    {workspace && activityOpen ? <Notifications key={`activity:${workspace}`} workspace={workspace} onOpen={item => void openMention(item)}/> : workspace && directOpen ? <DirectMessages key={`dms:${workspace}`} workspace={workspace} viewer={profile.id} requestedId={directId} compose={directCompose} width={sidebarWidth} onVisit={visit} onSearchAvailabilityChange={setCanSearch} renderConversation={(dm, controls) => <ChannelRoom key={dm.id} readState={controls.readState} uploads={uploads} profile={profile} channel={dm} onChannelChange={updated => controls.change(updated as DirectMessageSummary)} onLeft={() => void controls.close()} onCloseDirect={() => void controls.close()} drafts={draftState.current} onDraftChange={saveDraft} onAccessLost={() => forgetChannel(dm.id)} searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} composeRequest={0} mentionTarget={mentionTarget?.channel_id === dm.id ? mentionTarget.message_id : undefined} onMentionOpened={() => setMentionTarget(undefined)} />} /> : workspace ? <WorkspaceChannels onDirectMessage={openDirect} onNewDirectMessage={newDirect} uploads={uploads} profile={profile} workspace={workspace} workspaces={workspaces} onWorkspaceChange={changeWorkspace} width={sidebarWidth} onWidthChange={setSidebarWidth} onMembers={() => setMembersOpen(true)} requestedChannel={requestedChannel} mentionTarget={mentionTarget} onMentionOpened={() => setMentionTarget(undefined)} onVisit={visit} searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} onSearchAvailabilityChange={setCanSearch} drafts={draftState.current} onDraftChange={saveDraft} onForgetChannel={forgetChannel} /> : <section className="chat-empty chat-onboarding">{loaded ? <><div className="chat-empty-icon"><Sparkle size={32} /></div><h1>Your team’s next chapter starts here.</h1><p>Create a workspace for your team, or ask an existing workspace owner to add you.</p><form onSubmit={createWorkspace}><label>Workspace name<input required maxLength={100} placeholder="e.g. Space studio" value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} /></label><Button type="submit" variant="primary" loading={creating}>Create workspace</Button></form></> : <p role="status">Loading workspaces…</p>}</section>}
  </ChatShell>;
}
function WorkspaceChannels({ onDirectMessage, onNewDirectMessage, uploads, profile, workspace, workspaces, onWorkspaceChange, width, onWidthChange, onMembers, requestedChannel, mentionTarget, onMentionOpened, onVisit, searchOpen, onSearchClose, onSearchAvailabilityChange, drafts, onDraftChange, onForgetChannel }: { onDirectMessage: (id: string) => void; onNewDirectMessage: () => void; uploads: UploadDrafts; profile: Profile; workspace: string; workspaces: Workspace[]; onWorkspaceChange: (id: string) => void; width: number; onWidthChange: (width: number) => void; onMembers: () => void; requestedChannel?: string; mentionTarget?: {channel_id:string;message_id:string}; onMentionOpened: () => void; onVisit: (channel?: Channel) => void; searchOpen: boolean; onSearchClose: () => void; onSearchAvailabilityChange: (available: boolean) => void; drafts: Record<string, RichDocument>; onDraftChange: (key: string, document: RichDocument) => void; onForgetChannel: (id: string) => void }) {
  const reduced = useReducedMotion();
  const [views, setViews] = useState(() => new Map<string, ChannelView>());
  const unread = useWorkspaceUnread(workspace);
  const directs = useDirectMessageList(workspace);
  const { channels, selected, loaded, error } = views.get(workspace) ?? emptyChannelView;
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
    setName(''); setPrivate(false); setBusy(false); setCreateOpen(false); setComposeRequest(0);
    updateView(view => ({ ...view, error: '' }));
    async function load() {
      const version = channelMutation.current;
      try {
        const items = await listAll<Channel>(`/workspaces/${workspace}/channels`);
        if (!active) return;
        if (version !== channelMutation.current) { void load(); return; }
        forgetRevoked(items);
        if (latestRequestedChannel.current && !items.some(item => item.id === latestRequestedChannel.current)) {
          try { const requested = await request<Channel>(`/channels/${latestRequestedChannel.current}`); if (active && requested.kind === 'direct') { onDirectMessage(requested.id); return; } } catch { /* Inaccessible links fall back to the workspace. */ }
        }
        const ordered = items.sort((a, b) => Number(b.name === 'general') - Number(a.name === 'general') || a.name.localeCompare(b.name));
        const initial = ordered.find(c => c.id === latestRequestedChannel.current) ?? ordered.find(c => c.id === latestSelected.current) ?? ordered.find(c => c.joined) ?? ordered[0];
        updateView(() => ({ channels: ordered, selected: initial?.id ?? '', loaded: true, error: '' }));
        if (!initialized) { initialized = true; onVisit(initial); }
      } catch (e) {
        if (!active) return;
        const denied = e instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(e.message);
        updateView(view => ({ ...(denied ? { ...emptyChannelView, loaded: true } : view), error: errorText(e) }));
      }
    }
    const stop = subscribeUpdates('workspace', workspace, load, code => {
      active = false; forgetRevoked([]);
      updateView(() => ({ ...emptyChannelView, loaded: true, error: errorText(new Error(code)) }));
    });
    return () => { active = false; stop(); scope.current++; };
  }, [workspace]);
  useEffect(() => {
    if (requestedChannel && channels.some(channel => channel.id === requestedChannel)) { updateView(view => ({ ...view, selected: requestedChannel })); setComposeRequest(0); onSearchClose(); }
  }, [requestedChannel, channels]);
  function channelChanged(updated: Channel) {
    channelMutation.current++;
    updateView(view => ({ ...view, channels: view.channels.map(item => item.id === updated.id ? updated : item) }));
  }
  function leftChannel(channel: Channel) {
    channelMutation.current++;
    onForgetChannel(channel.id);
    const remaining = channels.filter(item => item.id !== channel.id);
    const next = remaining.find(item => item.joined) ?? remaining[0];
    updateView(view => ({ ...view, channels: channel.private ? view.channels.filter(item => item.id !== channel.id) : view.channels.map(item => item.id === channel.id ? { ...item, joined: false } : item), selected: channel.private ? next?.id ?? '' : view.selected }));
    if (channel.private) onVisit(next);
  }
  async function create(event: FormEvent) {
    channelMutation.current++;
    event.preventDefault(); setBusy(true); updateView(view => ({ ...view, error: '' }));
    const version = scope.current;
    try {
      const channel = await request<Channel>(`/workspaces/${workspace}/channels`, { name, private: isPrivate });
      channelMutation.current++;
      updateView(view => ({ ...view, channels: [...view.channels, channel], selected: version === scope.current ? channel.id : view.selected }));
      if (version !== scope.current) return;
      onVisit(channel); setName(''); setPrivate(false); setCreateOpen(false); onSearchClose();
    } catch (e) { updateView(view => ({ ...view, error: errorText(e) })); }
    finally { if (version === scope.current) setBusy(false); }
  }
  const channel = channels.find(c => c.id === selected);
  useEffect(() => { onSearchAvailabilityChange(Boolean(channel?.joined)); return () => onSearchAvailabilityChange(false); }, [workspace, channel?.joined, onSearchAvailabilityChange]);
  async function join() {
    channelMutation.current++;
    if (!channel) return; setBusy(true); updateView(view => ({ ...view, error: '' }));
    const version = scope.current;
    try { await request(`/channels/${channel.id}/join`, {}); channelMutation.current++; updateView(view => ({ ...view, channels: view.channels.map(c => c.id === channel.id ? { ...c, joined: true } : c) })); }
    catch (e) { updateView(view => ({ ...view, error: errorText(e) })); }
    finally { if (version === scope.current) setBusy(false); }
  }
  return <div className="chat-layout" style={{ '--chat-sidebar-width': `${width}px` } as CSSProperties}>
    <div id="chat-conversations" className="chat-sidebar">
      <WorkspaceSidebar workspaceId={workspace} workspace={workspaces.find(w => w.id === workspace)?.name ?? 'Workspace'} width={width} onWidthChange={onWidthChange}
        loading={!loaded && !error} showEmptySections onNewMessage={onNewDirectMessage}
        workspaceControl={<WorkspacePicker items={workspaces} value={workspace} onChange={onWorkspaceChange} onMembers={onMembers} />}
        channels={[...channels.map(c => ({ id: c.id, name: c.archived_at ? `${c.name} (archived)` : c.name, private: c.private, unread: c.joined ? unread.channels.find(item => item.channel_id === c.id)?.unread_count : 0, section: 'channels' as const })), ...directs.items.map(dm => ({ id: dm.id, name: dm.name, section: 'direct' as const, unread: unread.channels.find(item => item.channel_id === dm.id)?.unread_count ?? 0 }))]} selectedId={selected}
        onSelect={id => { if (directs.items.some(dm => dm.id === id)) { onDirectMessage(id); return; } updateView(view => ({ ...view, selected: id })); onVisit(channels.find(channel => channel.id === id)); setComposeRequest(0); onSearchClose(); }} onCreateChannel={() => setCreateOpen(true)}
        footer={false} />
      {!loaded && !error && <p className="chat-sidebar-loading" role="status">Loading conversations…</p>}
      {unread.error && <p className="chat-sidebar-loading" role="status">{unread.error}</p>}
      {error && channel?.joined && <p role="alert">{error}</p>}
    </div>
    {!loaded && !error ? <main id="chat-messages" tabIndex={-1} className="chat-workspace-loading" aria-busy="true"><div role="status" aria-label="Loading workspace">Loading workspace…</div><ConversationSkeleton /></main> : channel?.joined ? <ChannelRoom readState={unread.channels.find(item => item.channel_id === channel.id)} mentionTarget={mentionTarget?.channel_id === channel.id ? mentionTarget.message_id : undefined} onMentionOpened={onMentionOpened} key={channel.id} uploads={uploads} profile={profile} channel={channel} onChannelChange={channelChanged} onLeft={() => leftChannel(channel)} drafts={drafts} onDraftChange={onDraftChange} onAccessLost={() => onForgetChannel(channel.id)} searchOpen={searchOpen} onSearchClose={onSearchClose} composeRequest={composeRequest} /> : <motion.main initial={reduced ? false : { opacity: .65 }} animate={{ opacity: 1 }} transition={motionTransition(reduced)} id="chat-messages" tabIndex={-1} className="chat-empty"><div className="chat-empty-icon">{channel?.private ? <Lock size={32} /> : <Hash size={32} />}</div><h1>{channel ? channel.name : 'A place for every conversation'}</h1><p>{channel ? channel.archived_at ? 'Join this archived channel to read its message history.' : 'Join this channel to read and send messages with your team.' : loaded ? 'Create your first channel and bring your team together.' : 'Loading your channels…'}</p>{channel ? <Button variant="primary" loading={busy} onClick={() => void join()}>Join channel</Button> : loaded && <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={17} /> Create channel</Button>}{error && <p role="alert">{error}</p>}</motion.main>}
    <Dialog open={createOpen} title="Create a channel" onClose={() => setCreateOpen(false)}><form className="chat-form" onSubmit={create}><p>Channels bring the right people and conversations together.</p><label>Channel name<input maxLength={80} placeholder="e.g. product" value={name} required onChange={e => setName(e.target.value)} /></label><label className="chat-checkbox"><input type="checkbox" checked={isPrivate} onChange={e => setPrivate(e.target.checked)} /><span>Make private<small>Only added members can read and send messages.</small></span></label>{error && <p role="alert">{error}</p>}<div className="chat-form-actions"><Button disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</Button><Button variant="primary" type="submit" loading={busy}>Create channel</Button></div></form></Dialog>
  </div>;
}
function ConversationSkeleton() {
  return <div className="chat-conversation-skeleton" aria-hidden="true">{[0, 1, 2].map(row => <div key={row}><i /><span><i /><i /><i /></span></div>)}</div>;
}
function ChannelRoom({ onCloseDirect, readState, uploads, profile, channel, onChannelChange, onLeft, drafts, onDraftChange, onAccessLost, searchOpen, onSearchClose, composeRequest, mentionTarget, onMentionOpened }: { onCloseDirect?: () => void; readState?: ChannelUnread; uploads: UploadDrafts; profile: Profile; channel: Channel; onChannelChange: (channel: Channel) => void; onLeft: () => void; drafts: Record<string, RichDocument>; onDraftChange: (key: string, document: RichDocument) => void; onAccessLost: () => void; searchOpen: boolean; onSearchClose: () => void; composeRequest: number; mentionTarget?: string; onMentionOpened: () => void }) {
  const direct = channel.kind === 'direct' ? channel as DirectMessageSummary : undefined;
  const findMentions = useMentionSearch(channel.id);
  const [selectedMention, setSelectedMention] = useState<MentionReference>();
  const reduced = useReducedMotion();
  const [compact, setCompact] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1150px)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1150px)');
    const change = (event: MediaQueryListEvent) => setCompact(event.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [events, setEvents] = useState<ChatEvent[]>([]), [status, setStatus] = useState('Connecting'), [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [attachmentRevision, setAttachmentRevision] = useState('0');
  const [thread, setThread] = useState<string>(), [socket, setSocket] = useState<Socket>();
  const [navCandidates,setNavCandidates]=useState<NavigatorCandidate[]>([]);
  const agentTags=[...new Set(navCandidates.map(c=>agentMention(c,navCandidates)))];
  const [channelSearchOpen, setChannelSearchOpen] = useState(false), [searchQuery, setSearchQuery] = useState<string | null>(null), [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState('about');
  const showDetails = (tab = 'about') => { setDetailsTab(tab); setDetailsOpen(true); };
  const [filesOpen, setFilesOpen] = useState(false);
  const filesButton = useRef<HTMLButtonElement>(null);
  const [sessionView, setSessionView] = useState<{ thread: string; selected: string }>();
  const [sessionOpen, setSessionOpen] = useState(false);
  const channelTyping=useTypingPublisher(socket,channel.id,undefined,ready&&!channel.archived_at&&!sessionOpen&&!(compact&&thread));
  function openThread(id: string) {
    setSessionOpen(false); setThread(id); setSearchQuery(null); setFilesOpen(false);
  }
  function openSessions(threadId: string, selected: string) {
    setThread(undefined); setSearchQuery(null); setFilesOpen(false);
    setSessionView({ thread: threadId, selected }); setSessionOpen(true);
  }
  function openAgentSession(event: { payload: { task_id: string; owner_id: string } }) {
    const version = accessVersion.current;
    void request<import('@space/contracts').Task>(`/tasks/${event.payload.task_id}`).then(task => {
      if (accessVersion.current !== version) return;
      if (task.session_id) openSessions(task.thread_id, task.session_id);
      else openThread(task.thread_id);
    }).catch(reason => { if (accessVersion.current === version) setError(errorText(reason)); });
  }
  const [memoryOpen, setMemoryOpen] = useState(false), [memoryMessage, setMemoryMessage] = useState<{ id: string; text: string }>();
  const [sourceId, setSourceId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('channel') === channel.id ? params.get('message') : null;
  });
  useEffect(() => { if (mentionTarget) { setSourceId(mentionTarget); onMentionOpened(); } }, [mentionTarget, onMentionOpened]);
  useEffect(() => {
    if (!composeRequest) return;
    setThread(undefined); setSessionOpen(false); setSearchQuery(null); setFilesOpen(false);
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('#chat-messages .ql-editor')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [composeRequest]);
  useEffect(() => { if (searchOpen || channelSearchOpen) { setFilesOpen(false); setSessionOpen(false); } }, [searchOpen, channelSearchOpen]);
  const accessLost = useRef(onAccessLost); accessLost.current = onAccessLost;
  const revokeAccess = useRef<(reason: unknown) => void>(() => {});
  const cursor = useRef('0'), accessVersion = useRef(0);
  const timeline = useRef<TimelineHandle | null>(null), stickToBottom = useRef(true);
  const threadLive = useRef<((messages: ChatMessage[], sent?: boolean) => void) | null>(null);
  const history = useMessageHistory(`/channels/${channel.id}/messages`, reason => {
    if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) revokeAccess.current(reason);
    else setError(errorText(reason));
  }, true);
  useEffect(() => {
    let active = true, terminal = false, initialized = false, subscribing = false, resubscribe = false, generation = 0;
    const connection = acquireRealtime(), client = connection.socket;
    setSocket(client);
    const revoke = (reason: unknown) => {
      if (terminal) return;
      terminal = true; accessVersion.current++;
      if (active) {
        accessLost.current(); setError(errorText(reason)); setReady(false); history.clear(); setEvents([]);
        setThread(undefined); setSessionView(undefined); setSessionOpen(false); setFilesOpen(false); setSourceId(null); setSelectedMention(undefined);
        setMemoryOpen(false); setMemoryMessage(undefined); setStatus('Disconnected');
      }
      if (client.connected) void command(client, 'channel.unsubscribe', { channel_id: channel.id }).catch(() => {});
      connection.release();
      if (reason instanceof Error && reason.message === 'unauthorized') connection.expire();
    };
    revokeAccess.current = revoke;
    const terminalError = (code: string) => ['unauthorized', 'not_found', 'forbidden', 'invalid_cursor', 'invalid_id'].includes(code);
    const subscribe = async () => {
      if (!active || terminal || !initialized || !client.connected) return;
      if (subscribing) { resubscribe = true; return; }
      subscribing = true;
      const attempt = generation;
      try {
        await command(client, 'channel.subscribe', { channel_id: channel.id, after: cursor.current });
        if (active && !terminal && attempt === generation) { setStatus('Live'); setReady(true); setError(''); }
      } catch (reason) {
        if (!active || terminal || attempt !== generation) return;
        const code = reason instanceof Error ? reason.message : '';
        if (terminalError(code)) revoke(reason);
        else connection.recover();
      } finally { subscribing = false; if (resubscribe) { resubscribe = false; void subscribe(); } }
    };
    connection.on('chat.events', (batch: { channel_id: string; events: ChatEvent[]; cursor: string }) => {
      if (active && initialized && !terminal && batch.channel_id === channel.id) {
        const incoming = batch.events.flatMap(event => (event.type === 'message.created' || event.type === 'message.updated') ? [{ ...event.payload, sequence: event.payload.sequence ?? event.sequence }] : []);
        history.receive(incoming, stickToBottom.current); threadLive.current?.(incoming);
        if (incoming.some(message => message.author.id !== profile.id && message.document?.ops.some(op => op.attributes?.mention))) window.dispatchEvent(new Event('space:mentions-changed'));
        const attachment = incoming.filter(message => message.attachments?.length).at(-1);
        if (attachment) setAttachmentRevision(attachment.sequence!);
        setEvents(old => recentTasks(mergeEvents(old, batch.events.filter(event => event.type === 'task.event'))));
        cursor.current = batch.cursor;
      }
    });
    connection.on('connect', () => { void subscribe(); });
    connection.on('disconnect', () => { generation++; if (active && !terminal) { setStatus('Reconnecting'); setReady(false); } });
    connection.on('connect_error', () => { if (active && !terminal) { setStatus('Reconnecting'); setReady(false); } });
    connection.on('session.revoked', () => revoke(new Error('unauthorized')));
    connection.on('channel.revoked', (event: { channel_id: string; error: string }) => { if (event.channel_id === channel.id) revoke(new Error(event.error)); });
    connection.on('chat.error', (event: { error: string }) => { if (terminalError(event.error)) revoke(new Error(event.error)); });
    void Promise.all([history.load('latest'), request<ChatHistory>(`/channels/${channel.id}/history`)]).then(([page, replay]) => {
      if (!active || terminal || !page) return;
      setEvents(recentTasks(replay.events)); setHistoryLoaded(true); initialized = true;
      cursor.current = BigInt(page.event_cursor) < BigInt(replay.cursor) ? page.event_cursor : replay.cursor;
      if (client.connected) void subscribe(); else connection.connect();
    }).catch(reason => { if (active && !terminal) { if (reason instanceof Error && terminalError(reason.message)) revoke(reason); else setError(errorText(reason)); } });
    return () => {
      active = false; revokeAccess.current = () => {};
      if (client.connected) void command(client, 'channel.unsubscribe', { channel_id: channel.id }).catch(() => {});
      connection.release();
    };
  }, [channel.id, channel.workspace_id, historyAttempt]);
  const [atEnd, setAtEnd] = useState(true);
  const entryRead = useRef<string | undefined>(undefined);
  if (entryRead.current === undefined && readState) entryRead.current = readState.last_read_sequence;
  const messages = history.page?.messages ?? [];
  const readError = useChannelRead(channel.id, history.page?.newer_cursor ?? '0', readState?.last_read_sequence,
    historyLoaded && ready && !history.loading && !history.page?.has_newer && atEnd && !searchOpen && !channelSearchOpen && searchQuery === null && !filesOpen && !sourceId && !detailsOpen && !memoryOpen && !selectedMention && !sessionOpen);
  const firstUnread = entryRead.current === undefined ? undefined : messages.find(message => message.author.id !== profile.id && BigInt(message.sequence ?? '0') > BigInt(entryRead.current!))?.id;
  const arrivals = useMessageArrivals(messages, historyLoaded && !history.loading ? channel.id : null);
  const conversations = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const entries = conversations.get(message.thread_id) ?? [];
    entries.push(message); conversations.set(message.thread_id, entries);
  }
  const searchable = messages.map(m => ({ id: m.id, channel: channel.name, author: m.author.name, text: m.text, links: m.document?.ops.flatMap(op => op.attributes?.link ? [op.attributes.link] : []), thread: (m.reply_count ?? Math.max(0, (conversations.get(m.thread_id)?.length ?? 1) - 1)) > 0 }));
  const results = searchQuery ? searchMessages(searchable, searchQuery, profile.display_name) : [];
  function reveal(id: string) {
    setSearchQuery(null);
    setThread(undefined);
    setSessionOpen(false);
    setFilesOpen(false);

    requestAnimationFrame(() => timeline.current?.reveal(id));
  }
  function closeFiles() { setFilesOpen(false); requestAnimationFrame(() => filesButton.current?.focus()); }
  function toggleFiles() {
    if (filesOpen) { closeFiles(); return; }
    setThread(undefined); setSessionOpen(false); setSearchQuery(null); setFilesOpen(true);
  }
  function fileMessage(id: string) {
    if (messages.some(message => message.id === id)) reveal(id);
    else setSourceId(id);
  }
  function checkSourceAccess() {
    const version = accessVersion.current;
    // A missing source can be a stale link; recheck channel access before clearing drafts/history.
    void request(`/channels/${channel.id}/assets?limit=1`).catch(reason => {
      if (version === accessVersion.current && reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) revokeAccess.current(reason);
    });
  }
  const fileRevision = attachmentRevision;
  const activity = new Map<string, ChatEvent & { type: 'task.event' }>();
  for (const event of events) if (event.type === 'task.event') activity.set(event.payload.task_id, event);
  const messageEvents: ChatEvent[] = messages.map(message => ({ type: 'message.created', channel_id: channel.id, thread_id: message.thread_id, sequence: message.sequence!, occurred_at: message.created_at, payload: message }));
  const visibleEvents = messageEvents;
  const send = useMemo(() => socket ? messageSender(socket, channel.id, undefined, uploads.attempt(channel.id)) : async () => { throw new Error('Connecting'); }, [socket, channel.id]);
  async function react(message: ChatMessage, emoji: string) {
    const version = accessVersion.current;
    try {
      const updated = await request<ChatMessage>(`/channels/${channel.id}/messages/${message.id}/reactions`, {
        emoji, active: !message.reactions?.find(reaction => reaction.emoji === emoji)?.user_ids.includes(profile.id),
      });
      if (accessVersion.current !== version) return;
      history.receive([updated], stickToBottom.current); threadLive.current?.([updated]);
    } catch (reason) {
      if (accessVersion.current !== version) return;
      if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) revokeAccess.current(reason);
      else setError(errorText(reason));
    }
  }
  function message(m: ChatMessage, inThread = false, arriving = !inThread && arrivals.has(m.id)) {
    const replies = conversations.get(m.thread_id) ?? [];
    return <div key={m.id} id={`${inThread ? 'thread' : 'chat'}-message-${m.id}`} tabIndex={-1} className="chat-message-anchor"><ConversationMessage message={m} viewerId={profile.id} arrival={arriving} onReact={channel.archived_at ? undefined : emoji => { void react(m, emoji); }} actions={{ copyMessage: () => navigator.clipboard.writeText(m.text), ...(!direct ? { saveMemory: () => { setMemoryMessage({ id: m.id, text: m.text }); setMemoryOpen(true); } } : {}) }} onReply={inThread ? undefined : () => openThread(m.thread_id)} replyCount={!inThread ? m.reply_count ?? (replies[0]?.id === m.id ? replies.length - 1 : 0) : 0} onMentionClick={setSelectedMention} footer={m.agent_sessions?.map(session => <button key={session.id} type="button" className="sp-thread-link chat-session-link" aria-label={`Agent session: ${session.title}`} title={session.title} onClick={() => openSessions(m.thread_id, session.id)}><Robot size={14} aria-hidden="true" />Agent session<span>{session.title}</span></button>)}/></div>;
  }
  return <motion.div initial={false} animate={{ opacity: reduced || historyLoaded || status === 'Disconnected' ? 1 : .65 }} transition={motionTransition(reduced)} className={`chat-conversation ${thread ? 'chat-conversation--thread' : ''} ${searchQuery ? 'chat-conversation--search' : ''} ${filesOpen ? 'chat-conversation--files' : ''}`}><main className="chat-channel" id="chat-messages" tabIndex={-1} aria-hidden={compact && (thread || sessionOpen) ? true : undefined} inert={compact && !!(thread || sessionOpen)}><header className="chat-channel-header"><button className="chat-channel-title" aria-label={direct ? `Conversation details for ${channel.name}` : `Channel details for #${channel.name}`} onClick={() => showDetails()}>{direct ? <Avatar name={channel.name} initials={channel.name.slice(0, 2).toUpperCase()} size="sm" /> : channel.private ? <Lock size={20} weight="bold" /> : <Hash size={22} weight="bold" />}<h1>{channel.name}</h1></button>{channel.topic && <button className="chat-channel-topic" title={channel.topic} onClick={() => showDetails()}>{channel.topic}</button>}<div className="chat-header-actions">{!direct && <button className="chat-channel-member-button" aria-label="View channel members" onClick={() => showDetails('members')}><Users size={18} /> Members</button>}{direct && onCloseDirect && <IconButton label="Close direct message" onClick={onCloseDirect}><X size={20} /></IconButton>}<IconButton label={`Search in ${channel.name}`} onClick={() => setChannelSearchOpen(true)}><MagnifyingGlass size={20} /></IconButton></div></header>
    <div className="chat-channel-tabs"><span><ChatCircle size={15} /> Messages</span><button ref={filesButton} className="chat-files-tab" aria-expanded={filesOpen} disabled={!historyLoaded || status === 'Disconnected'} onClick={toggleFiles}><Paperclip size={15} /> Files</button>{!direct && <><button disabled={status === 'Disconnected'} onClick={() => { setMemoryMessage(undefined); setMemoryOpen(true); }}><BookOpen size={15} /> Memory</button><NavigatorSettings channel={channel.id} onCandidates={setNavCandidates} /></>}{channel.archived_at && <span className="chat-channel-privacy"><Archive size={14} /> Archived</span>}</div>
    {error && <p className="chat-error" role="alert">{error}{!historyLoaded && status !== 'Disconnected' && <Button size="sm" disabled={!!history.loading} onClick={() => { setError(''); history.clear(); setHistoryAttempt(value => value + 1); }}>Retry loading messages</Button>}</p>}
    {readError && <p role="status">{readError}</p>}
    <MessageTimeline onAtEndChange={setAtEnd} label={`Messages in ${channel.name}`} items={visibleEvents} page={history.page} loading={history.loading} latestVersion={history.latestVersion} load={history.load} pinned={stickToBottom} handle={timeline} busy={!historyLoaded && status !== 'Disconnected'} render={(event, index) => <>{(!index || new Date(visibleEvents[index - 1]!.occurred_at).toDateString() !== new Date(event.occurred_at).toDateString()) && <div className="chat-date-divider"><span>{new Date(event.occurred_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>}{event.type === 'message.created' && event.payload.id === firstUnread && <div className="chat-unread-divider" role="separator" aria-label="New messages"><span>New messages</span></div>}{event.type === 'message.created' ? message(event.payload) : event.type === 'task.event' ? <TaskActivity event={event} profile={profile} onOpenWorkspace={() => openAgentSession(event)} onThread={() => openThread(event.thread_id)} /> : null}</>}>
      {!historyLoaded && status !== 'Disconnected' ? <><p className="chat-loading-status" role="status" aria-label="Loading messages">Loading messages…</p><ConversationSkeleton /></> : !messages.length && <div className="chat-channel-welcome"><div className="chat-empty-icon">{direct ? <ChatCircle size={38} /> : <Hash size={38} />}</div><h2>{ready ? direct ? channel.name : `This is the beginning of #${channel.name}` : status === 'Disconnected' ? 'This conversation is unavailable' : `Opening ${direct ? '' : '#'}${channel.name}`}</h2><p>{ready ? direct ? direct.participants?.length === 1 ? 'Your space for notes, links, and files.' : `This is the beginning of your conversation with ${channel.name}.` : 'A shared space for your team’s ideas, questions, and progress. Send the first message.' : status === 'Disconnected' ? 'Your access may have changed. Select another conversation to continue.' : 'Getting your conversation ready…'}</p></div>}
    </MessageTimeline>{!direct&&!thread&&!sessionOpen&&!channel.archived_at&&status!=='Disconnected'&&<NavigatorSuggestions channel={channel.id} onThread={openThread} />}{channel.archived_at ? <div className="chat-channel-archived"><strong>This channel is archived</strong>Its messages are available to read.<br /><Button size="sm" onClick={() => showDetails('settings')}>View channel settings</Button></div> : status !== 'Disconnected' && <div className="chat-compose" onBlurCapture={channelTyping.blur}><TypingIndicator channel={channel.id} viewerId={profile.id} enabled={ready}/><RichComposer findMentions={findMentions} mentions={agentTags} attachmentsEnabled={uploads.enabled} attachments={uploads.drafts[channel.id] ?? []} onAttachmentsChange={files => uploads.change(channel.id, channel.id, files)} onRetryAttachment={id => uploads.retry(channel.id, channel.id, id)} channel={channel.name} placeholder={direct ? `Message ${channel.name}` : undefined} acknowledgedDocument={uploads.acknowledged[channel.id]} defaultValue={drafts[channel.id]} onDraftChange={document => {onDraftChange(channel.id, document);channelTyping.change(document);}} onSend={async (text, document, files, options) => { const saved = await send(text, document, files.map(file => file.id), options?.broadcast_confirmed); channelTyping.stop(); window.dispatchEvent(new Event('space:mentions-changed')); uploads.sent(channel.id, document, files); history.sent(saved); }} /></div>}</main>
    {status !== 'Disconnected' && <AnimatePresence>{thread && <SidePanel key="thread" role="region" className="chat-thread" aria-label="Thread"><ConversationHeader title="Thread" actions={<ThreadNotificationToggle key={thread} thread={thread}/>} channel={direct ? undefined : channel.name} status={direct ? channel.name : undefined} onClose={() => setThread(undefined)} />
      <ThreadHistory key={thread} thread={thread} channel={channel.id} live={threadLive} renderMessage={(m, arriving) => message(m, true, arriving)} activity={[...activity.values()].filter(event => event.thread_id === thread && !event.payload.data.session_managed)} profile={profile} onOpenWorkspace={openAgentSession} onAccessLost={reason => revokeAccess.current(reason)} footer={<>
      {!direct && <NavigatorSuggestions channel={channel.id} thread={thread} />}
      {socket && !channel.archived_at && <ThreadComposer viewerId={profile.id} key={`reply:${thread}`} onSent={saved => { history.receive([saved], stickToBottom.current); threadLive.current?.([saved], true); }} mentions={agentTags} uploads={uploads} socket={socket} channel={channel.id} thread={thread} draft={drafts[`thread:${channel.id}:${thread}`]} onDraftChange={document => onDraftChange(`thread:${channel.id}:${thread}`, document)} />}
      </>} />
    </SidePanel>}</AnimatePresence>}
    {status !== 'Disconnected' && sessionView && <SidePanel key={`sessions:${sessionView.thread}`} role="region" hidden={!sessionOpen} className="chat-thread chat-agent-sessions" aria-label="Agent session">
      <AgentSessions thread={sessionView.thread} channel={channel.id} viewerId={profile.id} initialSessionId={sessionView.selected} archived={!!channel.archived_at} channelName={channel.name} onBack={() => openThread(sessionView.thread)} onClose={() => setSessionOpen(false)} onAccessLost={() => revokeAccess.current(new Error('not_found'))} />
    </SidePanel>}
    {status !== 'Disconnected' && <AnimatePresence>{searchQuery && <SidePanel key="search" className="chat-search-results" aria-label="Search results"><header className="chat-channel-header"><h2>Search results</h2><IconButton label="Close search results" onClick={() => setSearchQuery(null)}><X size={20} /></IconButton></header><div className="chat-search-summary"><strong>{results.length} {results.length === 1 ? 'result' : 'results'} for “{searchQuery}”</strong><p>Loaded messages in {direct ? '' : '#'}{channel.name}</p></div><div className="chat-search-list">{results.map(result => <button key={result.id} onClick={() => reveal(result.id)}><strong>{result.author}</strong><p>{result.text}</p><span>Jump to message <ArrowLeft size={13} /></span></button>)}{!results.length && <div className="chat-empty"><MagnifyingGlass size={30} /><h3>No messages found</h3><p>Try a different phrase, or load older history to search more of this conversation.</p></div>}</div></SidePanel>}</AnimatePresence>}
    {status !== 'Disconnected' && <AnimatePresence>{filesOpen && <ChannelFiles direct={!!direct} key={channel.id} channel={channel.id} name={channel.name} revision={fileRevision} onClose={closeFiles} onMessage={fileMessage} onAccessLost={() => revokeAccess.current(new Error('not_found'))} />}</AnimatePresence>}
    <WorkspaceSearch open={searchOpen || channelSearchOpen} scope={`Search loaded messages in ${direct ? '' : '#'}${channel.name}. Load older history to include earlier messages.`} onClose={() => { setChannelSearchOpen(false); onSearchClose(); }} messages={searchable} channel={channel.name} currentUser={profile.display_name} initialQuery={channelSearchOpen ? `in:${channel.name} ` : ''} onSearch={query => { setSearchQuery(query); setThread(undefined); setSessionOpen(false); setFilesOpen(false); }} onSelect={result => reveal(result.id)} />
    {direct ? <Dialog open={detailsOpen} title={channel.name} onClose={() => setDetailsOpen(false)}><p>Only the participants in this conversation can read and send messages.</p><ul className="dm-details-members">{direct.participants?.map(person => <li key={person.id}><Avatar name={person.name} initials={person.name.slice(0, 2).toUpperCase()} size="sm" /><strong>{person.name}{person.id === profile.id ? ' (you)' : ''}</strong></li>)}</ul><Button onClick={onCloseDirect}>Close direct message</Button></Dialog> : <ChannelDetails channel={channel} viewer={profile.id} open={detailsOpen} initialTab={detailsTab} onClose={() => setDetailsOpen(false)} onChange={onChannelChange} onLeft={onLeft} />}
    {!direct && status !== 'Disconnected' && <ChannelMemory channel={channel.id} name={channel.name} open={memoryOpen} message={memoryMessage} onClose={() => { setMemoryOpen(false); setMemoryMessage(undefined); }} />}
    {selectedMention && status !== 'Disconnected' && <MentionDetails channel={channel.id} mention={selectedMention} onClose={() => setSelectedMention(undefined)} />}
    {sourceId && status !== 'Disconnected' && <SourceMessage direct={!!direct} key={sourceId} channel={channel.id} name={channel.name} messageId={sourceId} onUnavailable={checkSourceAccess} onClose={() => { setSourceId(null); const url = new URL(window.location.href); url.searchParams.delete('message'); window.history.replaceState({}, '', url); }} />}
  </motion.div>;
}
function recentTasks(events: ChatEvent[]): ChatEvent[] {
  const tasks = new Map<string, ChatEvent & { type: 'task.event' }>();
  for (const event of events) if (event.type === 'task.event') {
    const previous = tasks.get(event.payload.task_id);
    tasks.set(event.payload.task_id, { ...event, payload: { ...event.payload, data: { ...previous?.payload.data, ...event.payload.data } } });
  }
  return [...tasks.values()].slice(-100);
}
function ThreadHistory({ thread, channel, live, renderMessage, activity, profile, onAccessLost, onOpenWorkspace, footer }: { thread: string; channel: string; live: { current: ((messages: ChatMessage[], sent?: boolean) => void) | null }; renderMessage: (message: ChatMessage, arriving: boolean) => React.ReactNode; activity: ChatEvent[]; profile: Profile; onAccessLost: (reason: unknown) => void; onOpenWorkspace: (event: ChatEvent & { type: 'task.event' }) => void; footer?: React.ReactNode }) {
  const pinned = useRef(true);
  const [error, setError] = useState('');
  const history = useMessageHistory(`/threads/${thread}/history`, reason => {
    if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) onAccessLost(reason);
    else setError(errorText(reason));
  });
  useEffect(() => {
    live.current = (messages, sent) => { const matching = messages.filter(message => message.thread_id === thread); if (sent) { for (const message of matching) history.sent(message); } else history.receive(matching, pinned.current); };
    void history.load('latest');
    return () => { live.current = null; history.clear(); };
  }, [thread]);
  const messages = (history.page?.messages ?? []).filter(message => !message.agent_session_id);
  const rootId = messages.find(message => message.thread_root_id)?.thread_root_id ?? (!history.page?.has_older ? messages[0]?.id : undefined);
  const replyCount = Math.max(0, ...messages.map(message => message.reply_count ?? 0), messages.filter(message => message.id !== rootId).length);
  const arrivals = useMessageArrivals(messages, history.page && !history.loading ? thread : null);
  const messageEvents: ChatEvent[] = messages.map(message => ({ type: 'message.created', channel_id: channel, thread_id: thread, sequence: message.sequence!, occurred_at: message.created_at, payload: message }));
  const savedResponses = new Set(messages.filter(message => message.agent_response).map(message => message.task_id));
  const items = mergeEvents(messageEvents, (history.page ? activity : []).filter(event => (event.type !== 'task.event' || !savedResponses.has(event.payload.task_id)) && (!history.page?.has_older || BigInt(event.sequence) >= BigInt(history.page.older_cursor ?? '0')) && (!history.page?.has_newer || BigInt(event.sequence) <= BigInt(history.page.newer_cursor ?? '0'))));
  return <>{error && <p role="alert">{error} <Button size="sm" onClick={() => { setError(''); void history.load('latest'); }}>Retry thread history</Button></p>}<MessageTimeline label="Thread messages" items={items} page={history.page} loading={history.loading} latestVersion={history.latestVersion} load={history.load} pinned={pinned} footer={footer} busy={!history.page && !error} render={event => event.type === 'message.created' ? <>{renderMessage(event.payload, arrivals.has(event.payload.id))}{event.payload.id === rootId && replyCount > 0 && <ConversationReplyDivider count={replyCount} />}</> : event.type === 'task.event' ? <TaskActivity event={event} profile={profile} onOpenWorkspace={() => onOpenWorkspace(event)} /> : null}>{!history.page && !error && <p role="status">Loading thread…</p>}</MessageTimeline></>;
}
function ThreadComposer({ viewerId, mentions, uploads, socket, channel, thread, draft, onDraftChange, onSent }: {viewerId:string; onSent: (message: ChatMessage) => void; mentions: string[]; uploads: UploadDrafts; socket: Socket; channel: string; thread: string; draft?: RichDocument; onDraftChange: (document: RichDocument) => void }) {
  const send = useMemo(() => messageSender(socket, channel, thread, uploads.attempt(`thread:${channel}:${thread}`)), [socket, channel, thread]);
  const findMentions = useMentionSearch(channel);
  const typing=useTypingPublisher(socket,channel,thread);
  return <div onBlurCapture={typing.blur}><ConversationComposer typingIndicator={<TypingIndicator channel={channel} thread={thread} viewerId={viewerId}/>} findMentions={findMentions} mentions={mentions} attachmentsEnabled={uploads.enabled} attachments={uploads.drafts[`thread:${channel}:${thread}`] ?? []} onAttachmentsChange={files => uploads.change(`thread:${channel}:${thread}`, channel, files)} onRetryAttachment={id => uploads.retry(`thread:${channel}:${thread}`, channel, id)} channel="thread" acknowledgedDocument={uploads.acknowledged[`thread:${channel}:${thread}`]} defaultValue={draft} onDraftChange={document=>{onDraftChange(document);typing.change(document);}} onSend={async (text, document, files, options) => { const saved = await send(text, document, files.map(file => file.id), options?.broadcast_confirmed);typing.stop(); window.dispatchEvent(new Event('space:mentions-changed')); uploads.sent(`thread:${channel}:${thread}`, document, files); onSent(saved); }} /></div>;
}
function TaskActivity({ event, profile, onThread, onOpenWorkspace }: { event: ChatEvent & { type: 'task.event' }; profile: Profile; onThread?: () => void; onOpenWorkspace: () => void }) {
  const [decision, setDecision] = useState<'pending' | 'approved' | 'rejected'>('pending');
  async function decide(action: 'approve' | 'reject') {
    await request(`/tasks/${event.payload.task_id}/${action}`, {});
    setDecision(action === 'approve' ? 'approved' : 'rejected');
  }
  const response = readAgentResponse(event.payload.data.response);
  if (response) return <article className="chat-task"><AgentResponse response={response} fallback={String(event.payload.data.result ?? event.payload.data.text ?? '')} streaming={!/\.(completed|failed)$/.test(event.payload.type)} />
    {event.payload.type.endsWith('.failed') && <p role="alert">{String(event.payload.data.error ?? event.payload.data.code ?? 'The agent run failed.')}</p>}
    <div className="chat-actions"><Button size="sm" onClick={onOpenWorkspace}>Open agent session</Button>{onThread && <Button size="sm" variant="ghost" onClick={onThread}>Open thread</Button>}</div>
  </article>;
  if(event.payload.data.conversational && event.payload.type!=='task.proposed')return null;
  if (event.payload.type === 'task.proposed' && event.payload.owner_id === profile.id) return <div className="chat-task chat-task--approval"><AgentApproval requestId={event.payload.task_id} title="Run this agent task?" agent="Agent" scope="This conversation" status={decision} approveLabel="Approve task" rejectLabel="Reject" onDecide={value => decide(value === 'approved' ? 'approve' : 'reject')}><p>{String(event.payload.data.goal ?? 'Review the requested task before allowing it to run.')}</p></AgentApproval><div className="chat-actions"><Button size="sm" onClick={onOpenWorkspace}>Open agent session</Button>{onThread && <Button size="sm" variant="ghost" onClick={onThread}>Open thread</Button>}</div></div>;
  return <div className="chat-task"><AgentTaskCard title={String(event.payload.data.goal ?? 'Agent task')} status={decision === 'approved' ? 'queued' : decision === 'rejected' ? 'rejected' : taskEventStatus(event.payload.type)} detail={String(event.payload.data.text ?? event.payload.data.result ?? event.payload.data.error ?? event.payload.data.code ?? (event.payload.type === 'task.proposed' ? 'Waiting for the agent owner’s approval.' : ''))} onOpen={onOpenWorkspace} onThread={onThread} /></div>;
}
