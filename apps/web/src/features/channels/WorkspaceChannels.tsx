import { sessionPath, conversationPath } from '@space/contracts';
import { usePublishedPath } from '../../shared/ui/conversation-location.js';
import { RenameSessionDialog } from '../agents/RenameSessionDialog.js';
import { AgentSessions } from '../agents/AgentSessions.js';
import { useAgentSessionList } from '../agents/useAgentSessionList.js';
import type { Snapshot } from '../../shared/ui/view-state.js';
import type { ConversationView } from '../chat/view-state.js';
import { useStarredChannels } from './useStarredChannels.js';
import { useDirectMessageList } from '../direct-messages/DirectMessages.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { useWorkspaceUnread } from '../notifications/useWorkspaceUnread.js';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { DirectMessageSummary, AgentSessionReference } from '@space/contracts';
import { Button, Dialog } from '@space/ui/primitives';
import { WorkspaceSidebar } from '@space/ui/navigation';
import { motionTransition } from '@space/ui/motion';
import { type RichDocument } from '@space/ui/rich-text';
import { Hash, Lock, Plus } from '@phosphor-icons/react';
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

type ChannelView = { channels: Channel[]; selected: string; direct?: DirectMessageSummary; agentSession?: AgentSessionReference; loaded: boolean; error: string };
const emptyChannelView: ChannelView = { channels: [], selected: '', loaded: false, error: '' };
export function WorkspaceChannels({ initialSession, onSessionRestored, viewForChannel, onRequestedChannelConsumed, shortcut, onShortcut, content, onContentClose, onDirectMessage, onNewDirectMessage, uploads, profile, workspace, workspaces, workspaceControl, width, onWidthChange, requestedChannel, mentionTarget, onMentionOpened, onVisit, searchOpen, onSearchClose, onSearchAvailabilityChange, drafts, onDraftChange, onForgetChannel }: { initialSession?: AgentSessionReference; onSessionRestored: () => void; viewForChannel:(id:string)=>Snapshot<ConversationView>; onRequestedChannelConsumed: () => void; shortcut?: HubView; onShortcut: (view: HubView) => void; content?: ReactNode; onContentClose: () => void; onDirectMessage: (id: string) => void; onNewDirectMessage: () => void; uploads: UploadDrafts; profile: Profile; workspace: string; workspaces: Workspace[]; workspaceControl: ReactNode; width: number; onWidthChange: (width: number) => void;  requestedChannel?: string; mentionTarget?: {channel_id:string;message_id:string;thread_id?:string}; onMentionOpened: () => void; onVisit: (channel?: Channel) => void; searchOpen: boolean; onSearchClose: () => void; onSearchAvailabilityChange: (available: boolean) => void; drafts: Record<string, RichDocument>; onDraftChange: (key: string, document: RichDocument) => void; onForgetChannel: (id: string) => void }) {
  const reduced = useReducedMotion();
  const [views, setViews] = useState(() => new Map<string, ChannelView>(initialSession ? [[workspace, {...emptyChannelView, agentSession: initialSession}]] : []));
  useEffect(() => { if (initialSession) onSessionRestored(); }, [initialSession, onSessionRestored]);
  const unread = useWorkspaceUnread(workspace);
  const typing = useDirectTyping(workspace, profile.id);
  const directs = useDirectMessageList(workspace);
  const sessions = useAgentSessionList(workspace);
  const starred = useStarredChannels(workspace, undefined, profile.id);
  const starredSessions = useStarredChannels(workspace, undefined, profile.id, 'starred-sessions');
  const [renameId,setRenameId] = useState<string>();
  const sessionRows = [
    ...starredSessions.conversations.flatMap(item => item.session ? [{
      id:item.id, title:item.name, thread:item.session.origin_thread_id, agentName:item.session.agent_name,
      section:'starred' as const, working:item.working, canRename:item.can_rename,
    }] : []),
    ...sessions.items.filter(item => !starredSessions.ids.includes(item.id)).map(item => ({
      id:item.id, title:item.title, thread:item.origin_thread_id, agentName:item.agent_name,
      section:'sessions' as const, working:item.working, canRename:item.created_by===profile.id || item.owner_id===profile.id,
    })),
  ];
  const renameTarget = sessionRows.find(item => item.id === renameId && item.canRename);
  const { channels, selected, loaded, error } = views.get(workspace) ?? emptyChannelView;
  const [detailsId, setDetailsId] = useState<string>();
  const detailsChannel = channels.find(item => item.id === detailsId && item.joined);
  const sidebarPermissions = useChannelPermissions(detailsChannel?.id, workspace);
  const joinedIds = new Set(channels.filter(item => item.joined).map(item => item.id));
  const openDetails = (id: string) => joinedIds.has(id) ? () => setDetailsId(id) : undefined;
  const homeDirect = views.get(workspace)?.direct;
  const agentSession = views.get(workspace)?.agentSession;
  function closeSession() { updateView(view => ({...view,agentSession:undefined})); }
  useEffect(() => { if (shortcut || requestedChannel || mentionTarget) closeSession(); }, [shortcut,requestedChannel,mentionTarget,workspace]);
  useEffect(() => { if(agentSession) document.getElementById('chat-messages')?.focus(); },[agentSession?.id]);
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
    setRenameId(undefined); setDetailsId(undefined);
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
    updateView(view => ({ ...view, channels: view.channels.map(item => item.id === updated.id ? updated : item) }));
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
  return <div className="chat-layout" style={{ '--chat-sidebar-width': `${width}px` } as CSSProperties}>
    <div id="chat-conversations" className="chat-sidebar">
      <WorkspaceSidebar workspaceId={workspace} workspace={workspaces.find(w => w.id === workspace)?.name ?? 'Workspace'} width={width} onWidthChange={onWidthChange}
        loading={!loaded && !error} showEmptySections onNewMessage={onNewDirectMessage}
        selectedShortcut={shortcut} onThreads={() => onShortcut('threads')} onHuddles={() => onShortcut('huddles')} onDrafts={() => onShortcut('drafts')} onSaved={() => onShortcut('saved')} onDirectories={() => onShortcut('directories')}
        workspaceControl={workspaceControl}
        channels={[...starred.conversations.map(c => ({id:c.id,name:c.name,section:'starred' as const,onDetails:openDetails(c.id),private:c.private,typing:c.kind === 'direct' && typing.has(c.id)})), ...channels.filter(c => !starred.ids.includes(c.id)).map(c => ({ id: c.id, onDetails: openDetails(c.id), name: c.archived_at ? `${c.name} (archived)` : c.name, private: c.private, unread: c.joined ? unread.channels.find(item => item.channel_id === c.id)?.unread_count : 0, section: 'channels' as const })), ...sessionRows.map(item => ({ id:`session:${item.id}`, name:item.title, agentName:item.agentName, typing:item.working, section:item.section, onRename:item.canRename ? () => setRenameId(item.id) : undefined })), ...directs.items.filter(dm => !starred.ids.includes(dm.id)).map(dm => ({ id: dm.id, name: dm.name, typing: typing.has(dm.id), section: 'direct' as const, initials: (dm.participants.find(person => person.id !== profile.id) ?? dm.participants[0])?.name.slice(0, 2).toUpperCase(), image: (dm.participants.find(person => person.id !== profile.id) ?? dm.participants[0])?.image, online: (dm.participants.find(person => person.id !== profile.id) ?? dm.participants[0])?.presence === 'active', unread: unread.channels.find(item => item.channel_id === dm.id)?.unread_count ?? 0 }))]} selectedId={shortcut ? '' : agentSession ? `session:${agentSession.id}` : homeDirect?.id ?? selected}
        onSelect={id => { onContentClose(); const session = sessions.items.find(item => `session:${item.id}` === id) ?? starredSessions.conversations.find(item=>`session:${item.id}`===id)?.session; if (session) { updateView(view => ({...view,agentSession:session})); onSearchClose(); return; } closeSession(); if (directs.items.some(dm => dm.id === id) || starred.conversations.some(c => c.id === id && c.kind === 'direct')) { const dm = directs.items.find(item => item.id === id); if (dm) { updateView(view => ({ ...view, direct: dm })); onVisit(dm); onSearchClose(); } else onDirectMessage(id); return; } updateView(view => ({ ...view, selected: id, direct: undefined })); onVisit(channels.find(channel => channel.id === id)); setComposeRequest(0); onSearchClose(); }} onCreateChannel={() => setCreateOpen(true)}
        sectionFooters={{starred:<>
          {starredSessions.next&&<Button size="sm" onClick={starredSessions.loadMore}>More starred sessions</Button>}
          {starredSessions.hasPrevious&&<Button size="sm" onClick={starredSessions.first}>First starred sessions</Button>}
        </>,sessions:<>
          {sessions.loading && <p className="agent-session-sidebar-notice" role="status">Loading sessions…</p>}
          {sessions.error && <p className="agent-session-sidebar-notice" role="alert">{sessions.error} <Button size="sm" onClick={()=>void sessions.refresh()}>Retry sessions</Button></p>}
          {sessions.next_cursor && <button className="sp-sidebar-section-toggle" onClick={sessions.older}>Older sessions</button>}
          {sessions.hasPrevious && <button className="sp-sidebar-section-toggle" onClick={sessions.first}>Recent sessions</button>}
        </>}}
        footer={starred.next ? <Button size="sm" onClick={starred.loadMore}>More starred conversations</Button> : starred.hasPrevious ? <Button size="sm" onClick={starred.first}>First starred conversations</Button> : false} />
      {!loaded && !error && <p className="sp-sr-only" role="status">Loading conversations…</p>}
      {unread.error && <p className="chat-sidebar-loading" role="status">{unread.error}</p>}
      {error && channel?.joined && <p role="alert">{error}</p>}
    </div>
    {content ?? (agentSession ? <main id="chat-messages" tabIndex={-1} className="chat-channel" aria-label="Agent session"><AgentSessions key={agentSession.id} thread={agentSession.origin_thread_id} channel={agentSession.channel_id} initialSessionId={agentSession.id} viewerId={profile.id} archived={agentSession.channel_archived} drafts={drafts} onDraftChange={onDraftChange} attempt={uploads.attempt} acknowledged={uploads.acknowledged} onAccepted={(key,document)=>uploads.sent(key,document,[])} onClose={closeSession} onAccessLost={()=>{const key=`session:${agentSession.channel_id}:${agentSession.id}`;delete drafts[key];onDraftChange(key,{ops:[]});closeSession();void sessions.refresh();}}/></main> : !loaded && !error ? <ConversationLoading label="Loading workspace" /> : channel?.joined ? <ChannelRoom viewState={viewForChannel(channel.id)} readState={unread.channels.find(item => item.channel_id === channel.id)} requestedThread={mentionTarget?.channel_id === channel.id ? mentionTarget.thread_id : undefined} mentionTarget={mentionTarget?.channel_id === channel.id ? mentionTarget.message_id : undefined} onMentionOpened={onMentionOpened} key={channel.id} uploads={uploads} profile={profile} channel={channel} onChannelChange={updated => homeDirect ? updateView(view => ({ ...view, direct: updated as DirectMessageSummary })) : channelChanged(updated)} onCloseDirect={homeDirect ? () => void closeHomeDirect() : undefined} onLeft={() => leftChannel(channel)} drafts={drafts} onDraftChange={onDraftChange} onAccessLost={() => { onForgetChannel(channel.id); if (homeDirect) forgetDirect(channel.id, 'This conversation is unavailable'); }} searchOpen={searchOpen} onSearchClose={onSearchClose} composeRequest={composeRequest} /> : <motion.main initial={reduced ? false : { opacity: .65 }} animate={{ opacity: 1 }} transition={motionTransition(reduced)} id="chat-messages" tabIndex={-1} className="chat-empty"><div className="chat-empty-icon">{channel?.private ? <Lock size={32} /> : <Hash size={32} />}</div><h1>{channel ? channel.name : 'A place for every conversation'}</h1><p>{channel ? channel.archived_at ? 'Join this archived channel to read its message history.' : 'Join this channel to read and send messages with your team.' : loaded ? 'Create your first channel and bring your team together.' : 'Loading your channels…'}</p>{channel ? <Button variant="primary" loading={busy} onClick={() => void join()}>Join channel</Button> : loaded && <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={17} /> Create channel</Button>}{error && <p role="alert">{error}</p>}</motion.main>)}
    {detailsChannel && <ChannelDetails open channel={detailsChannel} viewer={profile.id} permissions={sidebarPermissions.snapshot}
      permissionsPending={!sidebarPermissions.snapshot} onClose={() => setDetailsId(undefined)} onChange={channelChanged}
      onLeft={() => { leftChannel(detailsChannel); setDetailsId(undefined); }} />}
    {renameTarget && <RenameSessionDialog key={renameTarget.id} id={renameTarget.id} title={renameTarget.title}
      workspace={workspace} thread={renameTarget.thread} viewerId={profile.id} onClose={()=>setRenameId(undefined)}/>}
    <Dialog open={createOpen} title="Create a channel" onClose={() => setCreateOpen(false)}><form className="chat-form" onSubmit={create}><p>Channels bring the right people and conversations together.</p><label>Channel name<input maxLength={80} placeholder="e.g. product" value={name} required onChange={e => setName(e.target.value)} /></label><label className="chat-checkbox"><input type="checkbox" checked={isPrivate} onChange={e => setPrivate(e.target.checked)} /><span>Make private<small>Only added members can read and send messages.</small></span></label>{error && <p role="alert">{error}</p>}<div className="chat-form-actions"><Button disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</Button><Button variant="primary" type="submit" loading={busy}>Create channel</Button></div></form></Dialog>
  </div>;
}
