import { NavigatorSettings, NavigatorSuggestions, ThreadAgentSubscription, agentMention } from './Navigator.js';
import { MessageTimeline, type TimelineHandle } from './MessageTimeline.js';
import { useMessageHistory } from './useMessageHistory.js';
import { AssetAttachments } from './AssetAttachments.js';
import { ChannelFiles } from './ChannelFiles.js';
import { ChannelMemory } from './ChannelMemory.js';
import { SourceMessage } from './SourceMessage.js';
import { AgentMessageBody, readAgentResponse } from './AgentMessageBody.js';
import { AgentResponse } from '@space/ui';
import { AgentTaskCard, AgentTaskWorkspace, taskEventStatus } from './AgentTaskWorkspace.js';
import { WorkspaceMembers } from './WorkspaceMembers.js';
import { ChannelDetails } from './ChannelDetails.js';
import { useEffect, useMemo, useRef, useState, useId, type CSSProperties, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { NavigatorCandidate, AgentInstallation, ChatEvent, ChatHistory, ChatMessage, ChannelSummary } from '@space/contracts';
import { AgentApproval, Badge, Button, Dialog, IconButton, Message, RichComposer, RichContent, WorkspaceSearch, WorkspaceSidebar, SidePanel, Reveal, motionTransition, searchMessages, useMessageArrivals, type Attachment, type RichDocument } from '@space/ui';
import { Archive, ArrowLeft, BookOpen, ChatCircle, Hash, Lock, MagnifyingGlass, Paperclip, Plus, Sparkle, Users, X } from '@phosphor-icons/react';
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
type ConversationVisit = { workspace: string; channel?: string; label: string };
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
  return <ChatWorkspace key={`${session.user.id}:${session.session.id}`} profile={{ id: session.user.id, display_name: session.user.name }} />;
}
function ChatWorkspace({ profile: initialProfile }: { profile: Profile }) {
  const [profile, setProfile] = useState(initialProfile);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]), [workspace, setWorkspace] = useState('');
  const [error, setError] = useState('');
  const [membersOpen, setMembersOpen] = useState(false);
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
  function changeWorkspace(id: string) {
    setCanSearch(false); setRequestedChannel(undefined); setWorkspace(id); setSearchOpen(false); setMembersOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.chat-workspace-switcher>summary')?.focus());
  }
  function visit(channel?: Channel) {
    setRequestedChannel(undefined);
    const entry = { workspace, channel: channel?.id, label: channel ? `#${channel.name} · ${workspaces.find(item => item.id === workspace)?.name ?? 'Workspace'}` : workspaces.find(item => item.id === workspace)?.name ?? 'Workspace' };
    setNavigation(previous => {
      const current = previous.entries[previous.index];
      if (current?.workspace === entry.workspace && current.channel === entry.channel) return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), entry];
      return { entries, index: entries.length - 1 };
    });
  }
  function travel(index: number) {
    const entry = navigation.entries[index];
    if (!entry || index === navigation.index) return;
    setSearchOpen(false); setMembersOpen(false);
    setRequestedChannel(entry.channel); setWorkspace(entry.workspace);
    setNavigation(previous => ({ ...previous, index }));
  }
  const [drafts, setDrafts] = useState<Record<string, RichDocument>>({});
  const draftState = useRef(drafts);
  function saveDraft(key: string, document: RichDocument) {
    draftState.current = { ...draftState.current, [key]: document };
    setDrafts(draftState.current);
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
    if (!files.length || !messageAttempts.current.has(key)) return;
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
    setDrafts(draftState.current);
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
  return <ChatShell name={selectedWorkspace?.name ?? 'Space'} user={profile.display_name} userId={profile.id} onNameChange={name => setProfile(old => old.display_name === name ? old : { ...old, display_name: name })} workspaces={workspaces} workspace={workspace} onWorkspaceChange={workspaces.length ? changeWorkspace : undefined} sidebarWidth={sidebarWidth} onBack={navigation.index > 0 ? () => travel(navigation.index - 1) : undefined} onForward={navigation.index < navigation.entries.length - 1 ? () => travel(navigation.index + 1) : undefined} history={recent.map(entry => ({ label: entry.label, onSelect: () => travel(entry.index) }))} onMembers={workspace ? () => setMembersOpen(true) : undefined} onSearch={canSearch ? () => setSearchOpen(true) : undefined}>
    {workspace && <WorkspaceMembers key={`members:${workspace}`} workspace={workspace} viewer={profile.id} open={membersOpen} onClose={() => setMembersOpen(false)} />}
    {error && <p role="alert">{error}</p>}
    {workspace ? <WorkspaceChannels uploads={uploads} profile={profile} workspace={workspace} workspaces={workspaces} onWorkspaceChange={changeWorkspace} width={sidebarWidth} onWidthChange={setSidebarWidth} onMembers={() => setMembersOpen(true)} requestedChannel={requestedChannel} onVisit={visit} searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} onSearchAvailabilityChange={setCanSearch} drafts={drafts} onDraftChange={saveDraft} onForgetChannel={forgetChannel} /> : <section className="chat-empty chat-onboarding">{loaded ? <><div className="chat-empty-icon"><Sparkle size={32} /></div><h1>Your team’s next chapter starts here.</h1><p>Create a workspace for your team, or ask an existing workspace owner to add you.</p><form onSubmit={createWorkspace}><label>Workspace name<input required maxLength={100} placeholder="e.g. Space studio" value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} /></label><Button type="submit" variant="primary" loading={creating}>Create workspace</Button></form></> : <p role="status">Loading workspaces…</p>}</section>}
  </ChatShell>;
}
function WorkspaceChannels({ uploads, profile, workspace, workspaces, onWorkspaceChange, width, onWidthChange, onMembers, requestedChannel, onVisit, searchOpen, onSearchClose, onSearchAvailabilityChange, drafts, onDraftChange, onForgetChannel }: { uploads: UploadDrafts; profile: Profile; workspace: string; workspaces: Workspace[]; onWorkspaceChange: (id: string) => void; width: number; onWidthChange: (width: number) => void; onMembers: () => void; requestedChannel?: string; onVisit: (channel?: Channel) => void; searchOpen: boolean; onSearchClose: () => void; onSearchAvailabilityChange: (available: boolean) => void; drafts: Record<string, RichDocument>; onDraftChange: (key: string, document: RichDocument) => void; onForgetChannel: (id: string) => void }) {
  const reduced = useReducedMotion();
  const [views, setViews] = useState(() => new Map<string, ChannelView>());
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
    let active = true;
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
        const ordered = items.sort((a, b) => Number(b.name === 'general') - Number(a.name === 'general') || a.name.localeCompare(b.name));
        const initial = ordered.find(c => c.id === latestRequestedChannel.current) ?? ordered.find(c => c.id === latestSelected.current) ?? ordered.find(c => c.joined) ?? ordered[0];
        updateView(() => ({ channels: ordered, selected: initial?.id ?? '', loaded: true, error: '' }));
        onVisit(initial);
      } catch (e) {
        if (!active) return;
        const denied = e instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(e.message);
        updateView(view => ({ ...(denied ? { ...emptyChannelView, loaded: true } : view), error: errorText(e) }));
      }
    }
    void load();
    return () => { active = false; scope.current++; };
  }, [workspace]);
  useEffect(() => {
    if (requestedChannel && channels.some(channel => channel.id === requestedChannel)) { updateView(view => ({ ...view, selected: requestedChannel })); setComposeRequest(0); onSearchClose(); }
  }, [requestedChannel, channels]);
  useEffect(() => {
    let active = true, pending = false;
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true;
      const version = channelMutation.current;
      try {
        const items = await listAll<Channel>(`/workspaces/${workspace}/channels`);
        if (active && version === channelMutation.current) {
          forgetRevoked(items);
          updateView(view => ({ ...view, channels: items.sort((a, b) => Number(b.name === 'general') - Number(a.name === 'general') || a.name.localeCompare(b.name)), selected: items.some(item => item.id === view.selected) ? view.selected : items.find(item => item.joined)?.id ?? items[0]?.id ?? '' }));
        }
      } catch { /* Keep the current view during a transient refresh failure. */ }
      finally { pending = false; }
    }
    const timer = setInterval(() => void refresh(), 10_000);
    window.addEventListener('focus', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [workspace]);
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
        loading={!loaded && !error} showEmptySections onNewMessage={channel?.joined ? () => setComposeRequest(value => value + 1) : undefined}
        workspaceControl={<WorkspacePicker items={workspaces} value={workspace} onChange={onWorkspaceChange} onMembers={onMembers} />}
        channels={channels.map(c => ({ id: c.id, name: c.archived_at ? `${c.name} (archived)` : c.name, private: c.private, section: 'channels' }))} selectedId={selected}
        onSelect={id => { updateView(view => ({ ...view, selected: id })); onVisit(channels.find(channel => channel.id === id)); setComposeRequest(0); onSearchClose(); }} onCreateChannel={() => setCreateOpen(true)}
        footer={false} />
      {!loaded && !error && <p className="chat-sidebar-loading" role="status">Loading conversations…</p>}
      {error && channel?.joined && <p role="alert">{error}</p>}
    </div>
    {!loaded && !error ? <main id="chat-messages" tabIndex={-1} className="chat-workspace-loading" aria-busy="true"><div role="status" aria-label="Loading workspace">Loading workspace…</div><ConversationSkeleton /></main> : channel?.joined ? <ChannelRoom key={channel.id} uploads={uploads} profile={profile} channel={channel} onChannelChange={channelChanged} onLeft={() => leftChannel(channel)} drafts={drafts} onDraftChange={onDraftChange} onAccessLost={() => onForgetChannel(channel.id)} searchOpen={searchOpen} onSearchClose={onSearchClose} composeRequest={composeRequest} /> : <motion.main initial={reduced ? false : { opacity: .65 }} animate={{ opacity: 1 }} transition={motionTransition(reduced)} id="chat-messages" tabIndex={-1} className="chat-empty"><div className="chat-empty-icon">{channel?.private ? <Lock size={32} /> : <Hash size={32} />}</div><h1>{channel ? channel.name : 'A place for every conversation'}</h1><p>{channel ? channel.archived_at ? 'Join this archived channel to read its message history.' : 'Join this channel to read and send messages with your team.' : loaded ? 'Create your first channel and bring your team together.' : 'Loading your channels…'}</p>{channel ? <Button variant="primary" loading={busy} onClick={() => void join()}>Join channel</Button> : loaded && <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={17} /> Create channel</Button>}{error && <p role="alert">{error}</p>}</motion.main>}
    <Dialog open={createOpen} title="Create a channel" onClose={() => setCreateOpen(false)}><form className="chat-form" onSubmit={create}><p>Channels bring the right people and conversations together.</p><label>Channel name<input maxLength={80} placeholder="e.g. product" value={name} required onChange={e => setName(e.target.value)} /></label><label className="chat-checkbox"><input type="checkbox" checked={isPrivate} onChange={e => setPrivate(e.target.checked)} /><span>Make private<small>Only added members can read and send messages.</small></span></label>{error && <p role="alert">{error}</p>}<div className="chat-form-actions"><Button disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</Button><Button variant="primary" type="submit" loading={busy}>Create channel</Button></div></form></Dialog>
  </div>;
}
function ConversationSkeleton() {
  return <div className="chat-conversation-skeleton" aria-hidden="true">{[0, 1, 2].map(row => <div key={row}><i /><span><i /><i /><i /></span></div>)}</div>;
}
function ChannelRoom({ uploads, profile, channel, onChannelChange, onLeft, drafts, onDraftChange, onAccessLost, searchOpen, onSearchClose, composeRequest }: { uploads: UploadDrafts; profile: Profile; channel: Channel; onChannelChange: (channel: Channel) => void; onLeft: () => void; drafts: Record<string, RichDocument>; onDraftChange: (key: string, document: RichDocument) => void; onAccessLost: () => void; searchOpen: boolean; onSearchClose: () => void; composeRequest: number }) {
  const reduced = useReducedMotion();
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [events, setEvents] = useState<ChatEvent[]>([]), [status, setStatus] = useState('Connecting'), [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [attachmentRevision, setAttachmentRevision] = useState('0');
  const [thread, setThread] = useState<string>(), [socket, setSocket] = useState<Socket>();
  const [agents, setAgents] = useState<AgentInstallation[]>([]);
  const [navCandidates,setNavCandidates]=useState<NavigatorCandidate[]>([]);
  const agentTags=[...new Set(navCandidates.map(c=>agentMention(c,navCandidates)))];
  const [channelSearchOpen, setChannelSearchOpen] = useState(false), [searchQuery, setSearchQuery] = useState<string | null>(null), [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState('about');
  const showDetails = (tab = 'about') => { setDetailsTab(tab); setDetailsOpen(true); };
  const [filesOpen, setFilesOpen] = useState(false);
  const filesButton = useRef<HTMLButtonElement>(null);
  const [agentWorkspace, setAgentWorkspace] = useState<{ id: string; owner: string }>();
  useEffect(() => { if (thread) setAgentWorkspace(undefined); }, [thread]);
  const workspaceOpener = useRef<HTMLElement | null>(null);
  function openAgentWorkspace(event: { payload: { task_id: string; owner_id: string } }) {
    workspaceOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setThread(undefined); setSearchQuery(null); setFilesOpen(false);
    setAgentWorkspace({ id: event.payload.task_id, owner: event.payload.owner_id });
  }
  function closeAgentWorkspace() {
    setAgentWorkspace(undefined);
    requestAnimationFrame(() => {
      if (workspaceOpener.current?.isConnected) workspaceOpener.current.focus();
      else document.getElementById('chat-messages')?.focus();
    });
  }
  const [memoryOpen, setMemoryOpen] = useState(false), [memoryMessage, setMemoryMessage] = useState<{ id: string; text: string }>();
  const [sourceId, setSourceId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('channel') === channel.id ? params.get('message') : null;
  });
  useEffect(() => {
    if (!composeRequest) return;
    setThread(undefined); setSearchQuery(null); setFilesOpen(false); setAgentWorkspace(undefined);
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('#chat-messages .ql-editor')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [composeRequest]);
  useEffect(() => { if (searchOpen || channelSearchOpen) { setFilesOpen(false); setAgentWorkspace(undefined); } }, [searchOpen, channelSearchOpen]);
  const accessLost = useRef(onAccessLost); accessLost.current = onAccessLost;
  const revokeAccess = useRef<(reason: unknown) => void>(() => {});
  const cursor = useRef('0'), accessVersion = useRef(0);
  const timeline = useRef<TimelineHandle | null>(null), stickToBottom = useRef(true);
  const threadLive = useRef<((messages: ChatMessage[]) => void) | null>(null);
  const history = useMessageHistory(`/channels/${channel.id}/messages`, reason => {
    if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) revokeAccess.current(reason);
    else setError(errorText(reason));
  });
  useEffect(() => {
    let active = true;
    const client = io({ transports: ['websocket'], withCredentials: true, autoConnect: false });
    setSocket(client);
    let terminal = false, retryDelay = 500, reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const revoke = (reason: unknown) => { if (terminal) return; if (reason instanceof Error && reason.message === 'unauthorized') window.dispatchEvent(new Event('space:session-expired')); terminal = true; accessVersion.current++; if (active) { accessLost.current(); setError(errorText(reason)); setReady(false); history.clear(); setEvents([]); setAgents([]); setThread(undefined); setFilesOpen(false); setAgentWorkspace(undefined); setSourceId(null); setMemoryOpen(false); setMemoryMessage(undefined); setStatus('Disconnected'); } client.disconnect(); };
    revokeAccess.current = revoke;
    const reconnect = () => {
      if (!active || terminal || reconnectTimer) return;
      setStatus('Reconnecting'); setReady(false);
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; if (active && !terminal) client.connect(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    };
    const terminalError = (code: string) => ['unauthorized', 'not_found', 'invalid_cursor', 'invalid_id'].includes(code);
    client.on('chat.events', (batch: { channel_id: string; events: ChatEvent[]; cursor: string }, ack: () => void) => {
      if (active && !terminal && batch.channel_id === channel.id) {
        const incoming = batch.events.flatMap(event => event.type === 'message.created' ? [{ ...event.payload, sequence: event.payload.sequence ?? event.sequence }] : []);
        history.receive(incoming, stickToBottom.current); threadLive.current?.(incoming);
        const attachment = incoming.filter(message => message.attachments?.length).at(-1);
        if (attachment) setAttachmentRevision(attachment.sequence!);
        setEvents(old => recentTasks(mergeEvents(old, batch.events.filter(event => event.type === 'task.event'))));
        cursor.current = batch.cursor;
      }
      ack();
    });
    client.on('connect', () => {
      void command(client, 'channel.subscribe', { channel_id: channel.id, after: cursor.current }).then(() => {
        if (active && !terminal) { retryDelay = 500; setStatus('Live'); setReady(true); setError(''); }
      }).catch(e => { if (terminalError(e.message)) revoke(e); client.disconnect(); reconnect(); });
    });
    client.on('disconnect', reason => { if (active && !terminal) { setStatus('Reconnecting'); setReady(false); if (reason === 'io server disconnect') reconnect(); } });
    client.on('connect_error', e => { if (e.message === 'unauthorized') { revoke(e); client.disconnect(); } else if (active) { setStatus('Reconnecting'); setReady(false); if (!client.active) reconnect(); } });
    client.on('chat.error', (e: { error: string }) => { if (terminalError(e.error)) revoke(new Error(e.error)); });
    void Promise.all([history.load('latest'), request<ChatHistory>(`/channels/${channel.id}/history`)]).then(([page, replay]) => {
      if (!active || terminal || !page) return;
      setEvents(recentTasks(replay.events)); setHistoryLoaded(true); cursor.current = BigInt(page.event_cursor) < BigInt(replay.cursor) ? page.event_cursor : replay.cursor; client.connect();
    }).catch(reason => { if (active && !terminal) { if (reason instanceof Error && terminalError(reason.message)) revoke(reason); else setError(errorText(reason)); } });
    void request<AgentInstallation[]>(`/agents/installations?workspace_id=${channel.workspace_id}`).then(result => { if (active) setAgents(result.filter(a => a.enabled)); }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; revokeAccess.current = () => {}; clearTimeout(reconnectTimer); client.disconnect(); };
  }, [channel.id, channel.workspace_id, historyAttempt]);
  const messages = history.page?.messages ?? [];
  const arrivals = useMessageArrivals(messages, historyLoaded && !history.loading ? channel.id : null);
  const conversations = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const entries = conversations.get(message.thread_id) ?? [];
    entries.push(message); conversations.set(message.thread_id, entries);
  }
  const searchable = messages.map(m => ({ id: m.id, channel: channel.name, author: m.author.name, text: m.text, links: m.document?.ops.flatMap(op => op.attributes?.link ? [op.attributes.link] : []), thread: (conversations.get(m.thread_id)?.length ?? 0) > 1 }));
  const results = searchQuery ? searchMessages(searchable, searchQuery, profile.display_name) : [];
  function reveal(id: string) {
    setSearchQuery(null);
    setThread(undefined);
    setFilesOpen(false);
    setAgentWorkspace(undefined);
    requestAnimationFrame(() => timeline.current?.reveal(id));
  }
  function closeFiles() { setFilesOpen(false); requestAnimationFrame(() => filesButton.current?.focus()); }
  function toggleFiles() {
    if (filesOpen) { closeFiles(); return; }
    setThread(undefined); setSearchQuery(null); setAgentWorkspace(undefined); setFilesOpen(true);
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
  const savedResponses = new Set(messages.filter(message => message.agent_response).map(message => message.task_id));
  const visibleEvents = mergeEvents(messageEvents, [...activity.values()].filter(event => !savedResponses.has(event.payload.task_id) && (!history.page?.has_older || BigInt(event.sequence) >= BigInt(history.page.older_cursor ?? '0')) && (!history.page?.has_newer || BigInt(event.sequence) <= BigInt(history.page.newer_cursor ?? '0'))));
  const send = useMemo(() => socket ? messageSender(socket, channel.id, undefined, uploads.attempt(channel.id)) : async () => { throw new Error('Connecting'); }, [socket, channel.id]);
  function message(m: ChatMessage, inThread = false) {
    const replies = conversations.get(m.thread_id) ?? [];
    return <div key={m.id} id={`${inThread ? 'thread' : 'chat'}-message-${m.id}`} tabIndex={-1} className="chat-message-anchor"><Message author={m.author.name} initials={m.author.name.slice(0, 2).toUpperCase()} agent={m.author.kind === 'agent'} tone={m.author.kind === 'agent' ? 'green' : m.author.id === profile.id ? 'blue' : 'purple'} arrival={!inThread && arrivals.has(m.id)} time={new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} actions={{ copyMessage: () => navigator.clipboard.writeText(m.text), saveMemory: () => { setMemoryMessage({ id: m.id, text: m.text }); setMemoryOpen(true); } }} onReply={inThread ? undefined : () => { setThread(m.thread_id); setSearchQuery(null); setFilesOpen(false); setAgentWorkspace(undefined); }} replyCount={!inThread && replies[0]?.id === m.id ? replies.length - 1 : 0}>
      <AgentMessageBody message={m} />
      {!!m.attachments?.length && <AssetAttachments assets={m.attachments} />}
      {m.agent_response && m.task_id && <div className="chat-actions"><Button size="sm" onClick={() => openAgentWorkspace({ payload: { task_id: m.task_id!, owner_id: activity.get(m.task_id!)?.payload.owner_id ?? '' } })}>Open workspace</Button></div>}
    </Message></div>;
  }
  return <motion.div initial={false} animate={{ opacity: reduced || historyLoaded || status === 'Disconnected' ? 1 : .65 }} transition={motionTransition(reduced)} className={`chat-conversation ${thread ? 'chat-conversation--thread' : ''} ${searchQuery ? 'chat-conversation--search' : ''} ${filesOpen ? 'chat-conversation--files' : ''}`}><main className="chat-channel" id="chat-messages" tabIndex={-1}><header className="chat-channel-header"><button className="chat-channel-title" aria-label={`Channel details for #${channel.name}`} onClick={() => showDetails()}>{channel.private ? <Lock size={20} weight="bold" /> : <Hash size={22} weight="bold" />}<h1>{channel.name}</h1></button>{channel.topic && <button className="chat-channel-topic" title={channel.topic} onClick={() => showDetails()}>{channel.topic}</button>}<div className="chat-header-actions"><button className="chat-channel-member-button" aria-label="View channel members" onClick={() => showDetails('members')}><Users size={18} /> Members</button><Badge tone={ready ? 'success' : 'warning'} dot>{status}</Badge><IconButton label={`Search in ${channel.name}`} onClick={() => setChannelSearchOpen(true)}><MagnifyingGlass size={20} /></IconButton></div></header>
    <div className="chat-channel-tabs"><span><ChatCircle size={15} /> Messages</span><button ref={filesButton} className="chat-files-tab" aria-expanded={filesOpen} disabled={!historyLoaded || status === 'Disconnected'} onClick={toggleFiles}><Paperclip size={15} /> Files</button><button disabled={status === 'Disconnected'} onClick={() => { setMemoryMessage(undefined); setMemoryOpen(true); }}><BookOpen size={15} /> Memory</button><NavigatorSettings channel={channel.id} onCandidates={setNavCandidates} /><span className="chat-channel-privacy">{channel.archived_at ? <><Archive size={14} /> Archived</> : channel.private ? 'Private channel' : 'Public channel'}</span></div>
    {error && <p className="chat-error" role="alert">{error}{!historyLoaded && status !== 'Disconnected' && <Button size="sm" disabled={!!history.loading} onClick={() => { setError(''); history.clear(); setHistoryAttempt(value => value + 1); }}>Retry loading messages</Button>}</p>}
    <MessageTimeline label={`Messages in ${channel.name}`} items={visibleEvents} page={history.page} loading={history.loading} latestVersion={history.latestVersion} load={history.load} pinned={stickToBottom} handle={timeline} busy={!historyLoaded && status !== 'Disconnected'} render={(event, index) => <>{(!index || new Date(visibleEvents[index - 1]!.occurred_at).toDateString() !== new Date(event.occurred_at).toDateString()) && <div className="chat-date-divider"><span>{new Date(event.occurred_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>}{event.type === 'message.created' ? message(event.payload) : <TaskActivity event={event} profile={profile} onOpenWorkspace={() => openAgentWorkspace(event)} onThread={() => { setThread(event.thread_id); setSearchQuery(null); setFilesOpen(false); setAgentWorkspace(undefined); }} />}</>}>
      {!historyLoaded && status !== 'Disconnected' ? <><p className="chat-loading-status" role="status" aria-label="Loading messages">Loading messages…</p><ConversationSkeleton /></> : !messages.length && <div className="chat-channel-welcome"><div className="chat-empty-icon"><Hash size={38} /></div><h2>{ready ? `This is the beginning of #${channel.name}` : status === 'Disconnected' ? 'This conversation is unavailable' : `Opening #${channel.name}`}</h2><p>{ready ? 'A shared space for your team’s ideas, questions, and progress. Send the first message.' : status === 'Disconnected' ? 'Your access may have changed. Select another conversation to continue.' : 'Getting your conversation ready…'}</p></div>}
    </MessageTimeline>{!thread&&!channel.archived_at&&status!=='Disconnected'&&<NavigatorSuggestions channel={channel.id} onThread={id=>{setThread(id);setSearchQuery(null);setFilesOpen(false);}} />}{channel.archived_at ? <div className="chat-channel-archived"><strong>This channel is archived</strong>Its messages are available to read.<br /><Button size="sm" onClick={() => showDetails('settings')}>View channel settings</Button></div> : status !== 'Disconnected' && <div className="chat-compose"><RichComposer mentions={agentTags} attachmentsEnabled={uploads.enabled} attachments={uploads.drafts[channel.id] ?? []} onAttachmentsChange={files => uploads.change(channel.id, channel.id, files)} onRetryAttachment={id => uploads.retry(channel.id, channel.id, id)} channel={channel.name} acknowledgedDocument={uploads.acknowledged[channel.id]} defaultValue={drafts[channel.id]} onDraftChange={document => onDraftChange(channel.id, document)} onSend={async (text, document, files) => { await send(text, document, files.map(file => file.id)); uploads.sent(channel.id, document, files); }} /></div>}</main>
    {status !== 'Disconnected' && <AnimatePresence>{thread && <SidePanel key="thread" role="region" className="chat-thread" aria-label="Thread"><header className="chat-channel-header"><div className="chat-thread-title"><ChatCircle size={20} /><h2>Thread</h2><span>#{channel.name}</span></div><IconButton label="Close thread" onClick={() => setThread(undefined)}><X size={20} /></IconButton></header>
      <ThreadHistory key={thread} thread={thread} channel={channel.id} live={threadLive} renderMessage={m => message(m, true)} activity={[...activity.values()].filter(event => event.thread_id === thread)} profile={profile} onOpenWorkspace={openAgentWorkspace} onAccessLost={reason => revokeAccess.current(reason)} />
      <NavigatorSuggestions channel={channel.id} thread={thread} /><ThreadAgentSubscription thread={thread} />
      {!channel.archived_at && <AgentRequest key={`agent:${thread}`} workspace={channel.workspace_id} thread={thread} agents={agents} />}
      {socket && !channel.archived_at && <ThreadComposer key={`reply:${thread}`} mentions={agentTags} uploads={uploads} socket={socket} channel={channel.id} thread={thread} draft={drafts[`thread:${channel.id}:${thread}`]} onDraftChange={document => onDraftChange(`thread:${channel.id}:${thread}`, document)} />}
    </SidePanel>}</AnimatePresence>}
    {status !== 'Disconnected' && <AnimatePresence>{searchQuery && <SidePanel key="search" className="chat-search-results" aria-label="Search results"><header className="chat-channel-header"><h2>Search results</h2><IconButton label="Close search results" onClick={() => setSearchQuery(null)}><X size={20} /></IconButton></header><div className="chat-search-summary"><strong>{results.length} {results.length === 1 ? 'result' : 'results'} for “{searchQuery}”</strong><p>Loaded messages in #{channel.name}</p></div><div className="chat-search-list">{results.map(result => <button key={result.id} onClick={() => reveal(result.id)}><strong>{result.author}</strong><p>{result.text}</p><span>Jump to message <ArrowLeft size={13} /></span></button>)}{!results.length && <div className="chat-empty"><MagnifyingGlass size={30} /><h3>No messages found</h3><p>Try a different phrase, or load older history to search more of this conversation.</p></div>}</div></SidePanel>}</AnimatePresence>}
    {status !== 'Disconnected' && <AnimatePresence>{filesOpen && <ChannelFiles key={channel.id} channel={channel.id} name={channel.name} revision={fileRevision} onClose={closeFiles} onMessage={fileMessage} onAccessLost={() => revokeAccess.current(new Error('not_found'))} />}</AnimatePresence>}
    {status !== 'Disconnected' && <AnimatePresence>{agentWorkspace && <AgentTaskWorkspace key={agentWorkspace.id} taskId={agentWorkspace.id} ownerId={agentWorkspace.owner} viewerId={profile.id} channelName={channel.name} revision={activity.get(agentWorkspace.id)?.sequence} onClose={closeAgentWorkspace} onAccessLost={closeAgentWorkspace} />}</AnimatePresence>}
    <WorkspaceSearch open={searchOpen || channelSearchOpen} scope={`Search loaded messages in #${channel.name}. Load older history to include earlier messages.`} onClose={() => { setChannelSearchOpen(false); onSearchClose(); }} messages={searchable} channel={channel.name} currentUser={profile.display_name} initialQuery={channelSearchOpen ? `in:${channel.name} ` : ''} onSearch={query => { setSearchQuery(query); setThread(undefined); setFilesOpen(false); setAgentWorkspace(undefined); }} onSelect={result => reveal(result.id)} />
    <ChannelDetails channel={channel} viewer={profile.id} open={detailsOpen} initialTab={detailsTab} onClose={() => setDetailsOpen(false)} onChange={onChannelChange} onLeft={onLeft} />
    {status !== 'Disconnected' && <ChannelMemory channel={channel.id} name={channel.name} open={memoryOpen} message={memoryMessage} onClose={() => { setMemoryOpen(false); setMemoryMessage(undefined); }} />}
    {sourceId && status !== 'Disconnected' && <SourceMessage key={sourceId} channel={channel.id} name={channel.name} messageId={sourceId} onUnavailable={checkSourceAccess} onClose={() => { setSourceId(null); const url = new URL(window.location.href); url.searchParams.delete('message'); window.history.replaceState({}, '', url); }} />}
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
function ThreadHistory({ thread, channel, live, renderMessage, activity, profile, onAccessLost, onOpenWorkspace }: { thread: string; channel: string; live: { current: ((messages: ChatMessage[]) => void) | null }; renderMessage: (message: ChatMessage) => React.ReactNode; activity: ChatEvent[]; profile: Profile; onAccessLost: (reason: unknown) => void; onOpenWorkspace: (event: ChatEvent & { type: 'task.event' }) => void }) {
  const pinned = useRef(true);
  const [error, setError] = useState('');
  const history = useMessageHistory(`/threads/${thread}/history`, reason => {
    if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) onAccessLost(reason);
    else setError(errorText(reason));
  });
  useEffect(() => {
    live.current = messages => history.receive(messages.filter(message => message.thread_id === thread), pinned.current);
    void history.load('latest');
    return () => { live.current = null; history.clear(); };
  }, [thread]);
  const messageEvents: ChatEvent[] = (history.page?.messages ?? []).map(message => ({ type: 'message.created', channel_id: channel, thread_id: thread, sequence: message.sequence!, occurred_at: message.created_at, payload: message }));
  const savedResponses = new Set((history.page?.messages ?? []).filter(message => message.agent_response).map(message => message.task_id));
  const items = mergeEvents(messageEvents, activity.filter(event => (event.type !== 'task.event' || !savedResponses.has(event.payload.task_id)) && (!history.page?.has_older || BigInt(event.sequence) >= BigInt(history.page.older_cursor ?? '0')) && (!history.page?.has_newer || BigInt(event.sequence) <= BigInt(history.page.newer_cursor ?? '0'))));
  return <>{error && <p role="alert">{error} <Button size="sm" onClick={() => { setError(''); void history.load('latest'); }}>Retry thread history</Button></p>}<MessageTimeline label="Thread messages" items={items} page={history.page} loading={history.loading} latestVersion={history.latestVersion} load={history.load} pinned={pinned} render={event => event.type === 'message.created' ? renderMessage(event.payload) : <TaskActivity event={event} profile={profile} onOpenWorkspace={() => onOpenWorkspace(event)} />}>{!history.page && !error && <p role="status">Loading thread…</p>}</MessageTimeline></>;
}
function ThreadComposer({ mentions, uploads, socket, channel, thread, draft, onDraftChange }: { mentions: string[]; uploads: UploadDrafts; socket: Socket; channel: string; thread: string; draft?: RichDocument; onDraftChange: (document: RichDocument) => void }) {
  const send = useMemo(() => messageSender(socket, channel, thread, uploads.attempt(`thread:${channel}:${thread}`)), [socket, channel, thread]);
  return <div className="chat-compose"><RichComposer mentions={mentions} attachmentsEnabled={uploads.enabled} attachments={uploads.drafts[`thread:${channel}:${thread}`] ?? []} onAttachmentsChange={files => uploads.change(`thread:${channel}:${thread}`, channel, files)} onRetryAttachment={id => uploads.retry(`thread:${channel}:${thread}`, channel, id)} channel="thread" acknowledgedDocument={uploads.acknowledged[`thread:${channel}:${thread}`]} defaultValue={draft} onDraftChange={onDraftChange} onSend={async (text, document, files) => { await send(text, document, files.map(file => file.id)); uploads.sent(`thread:${channel}:${thread}`, document, files); }} /></div>;
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
    <div className="chat-actions"><Button size="sm" onClick={onOpenWorkspace}>Open workspace</Button>{onThread && <Button size="sm" variant="ghost" onClick={onThread}>Open thread</Button>}</div>
  </article>;
  if(event.payload.data.conversational && event.payload.type!=='task.proposed')return null;
  if (event.payload.type === 'task.proposed' && event.payload.owner_id === profile.id) return <div className="chat-task chat-task--approval"><AgentApproval requestId={event.payload.task_id} title="Run this agent task?" agent="Agent" scope="This conversation" status={decision} approveLabel="Approve task" rejectLabel="Reject" onDecide={value => decide(value === 'approved' ? 'approve' : 'reject')}><p>{String(event.payload.data.goal ?? 'Review the requested task before allowing it to run.')}</p></AgentApproval><div className="chat-actions"><Button size="sm" onClick={onOpenWorkspace}>Open workspace</Button>{onThread && <Button size="sm" variant="ghost" onClick={onThread}>Open thread</Button>}</div></div>;
  return <div className="chat-task"><AgentTaskCard title={String(event.payload.data.goal ?? 'Agent task')} status={decision === 'approved' ? 'queued' : decision === 'rejected' ? 'rejected' : taskEventStatus(event.payload.type)} detail={String(event.payload.data.text ?? event.payload.data.result ?? event.payload.data.error ?? event.payload.data.code ?? (event.payload.type === 'task.proposed' ? 'Waiting for the agent owner’s approval.' : ''))} onOpen={onOpenWorkspace} onThread={onThread} /></div>;
}
function AgentRequest({ workspace, thread, agents }: { workspace: string; thread: string; agents: AgentInstallation[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [selection, setSelection] = useState(''), [goal, setGoal] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const [installation_id, skill] = selection.split('|');
    const body = { workspace_id: workspace, thread_id: thread, installation_id, skill, goal };
    const fingerprint = JSON.stringify(body);
    if (attempt.current?.body !== fingerprint) attempt.current = { body: fingerprint, key: crypto.randomUUID() };
    try { await request('/tasks', body, attempt.current.key); attempt.current = undefined; setGoal(''); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <section className="chat-agent-request"><button type="button" className="chat-agent-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><Sparkle size={16} /> Ask an agent</button><Reveal open={open} id={id}>{agents.length ? <form onSubmit={submit}>
    <label>Agent and skill<select required value={selection} onChange={e => setSelection(e.target.value)}><option value="">Choose a skill</option>{agents.flatMap(a => a.capabilities.skills.map(skill => <option key={`${a.id}|${skill}`} value={`${a.id}|${skill}`}>{a.connector_id} · {skill} · {a.id.slice(0, 8)}</option>))}</select></label>
    <label>What should the agent do?<textarea required maxLength={4000} value={goal} onChange={e => setGoal(e.target.value)} /></label><small>The agent needs a channel grant and its owner’s approval.</small>
    <Button size="sm" type="submit" loading={busy}>Request task</Button>{error && <p role="alert">{error}</p>}
  </form> : <p>No agents are available in this workspace.</p>}</Reveal></section>;
}
