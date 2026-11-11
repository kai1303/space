import { CollectionRailPreview } from '../features/workspace/collections/CollectionRailPreview.js';
import { SpacebotPreview } from '../features/workspace/collections/SpacebotPreview.js';
import type { RailPreview } from './shell/RailNavigation.js';
import { ConversationLinkLoading } from './shell/ConversationLinkLoading.js';
import { WorkspaceQueryProvider } from '../shared/realtime/workspace-query-cache.js';
import { ConversationLocation } from '../shared/ui/conversation-location.js';
import { parseConversationPath, parseSessionPath, sessionPath, workspaceIdFromPath, workspacePath, type AgentSessionReference } from '@space/contracts';
import { DestinationTransition } from './navigation/DestinationTransition.js';
import { WorkspaceMembers } from '../features/workspace/members/WorkspaceMembers.js';
import { WorkspaceSettings } from '../features/workspace/settings/WorkspaceSettings.js';
import { WorkspaceCollections } from '../features/workspace/collections/WorkspaceCollections.js';
import { WorkspaceDestinations } from '../features/workspace/collections/WorkspaceDestinations.js';
import { ComposerDrafts } from '../features/composer/ComposerDrafts.js';
import { ActivityPeek, Notifications } from '../features/notifications/Notifications.js';
import { DirectMessagesPeek, DirectMessages } from '../features/direct-messages/DirectMessages.js';
import { MentionInbox } from "../features/mentions/Mentions.js";
import { WorkspaceAdministration } from '../features/workspace/members/WorkspaceAdministration.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { motionTransition } from '@space/ui/motion';
import { AccessFrame, AccessLoading } from '../features/auth/AccessFrame.js';
import { WorkspaceSetup } from '../features/workspace/onboarding/WorkspaceSetup.js';
import type { DirectMessageSummary } from '@space/contracts';
import { Button } from '@space/ui/primitives';
import { acquireRealtime } from '../shared/realtime/socket-session.js';
import { listAll, request } from '../shared/api/request.js';
import { ChatShell } from './shell/ChatShell.js';
import { WorkspaceActions } from './shell/WorkspaceActions.js';
import type { Workspace } from '../features/workspace/workspace-types.js';
import type { Profile } from '../features/profile/profile-types.js';
import { homeShortcuts } from '../features/workspace/collections/hub-view.js';
import { errorText } from '../shared/api/error-text.js';
import { WorkspaceChannels } from '../features/channels/WorkspaceChannels.js';
import { ChannelRoom } from '../features/chat/ChannelRoom.js';
import { MessageSearch } from '../features/search/MessageSearch.js';
import { useNavigation } from './navigation/useNavigation.js';
import { useSidebarWidth } from './shell/useSidebarWidth.js';
import { getMessageOutbox } from '../features/composer/message-outbox.js';
import { useAttachmentUploads } from '../features/composer/useAttachmentUploads.js';
import { ProfileProvider } from '../features/profile/MemberProfile.js';
import { profileMessageDraft } from '../features/profile/profile-message.js';

function browserAddress() {
  return { path: location.pathname + location.search, view: window.history.state?.spaceView as string | undefined };
}

export function ChatWorkspace({ profile }: { profile: Profile }) {
  const attachments = useAttachmentUploads(profile.id);
  const [revision, setRevision] = useState(0);
  const address = useRef(browserAddress());
  const restore = useCallback(() => {
    const current = browserAddress();
    if (current.path !== address.current.path || current.view !== address.current.view) {
      address.current = current;
      setRevision(value => value + 1);
    }
  }, []);
  useEffect(() => {
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [restore]);
  function openSession(session: AgentSessionReference) {
    const path = sessionPath(session.id);
    if (path && path !== location.pathname) {
      history.pushState(null, '', path);
      restore();
    }
  }
  return <WorkspaceView key={revision} profile={profile} attachments={attachments} address={address} onOpenSession={openSession}/>;
}

function WorkspaceView({ profile: initialProfile, attachments, address, onOpenSession }: {
  onOpenSession: (session: AgentSessionReference) => void;
  profile: Profile;
  attachments: ReturnType<typeof useAttachmentUploads>;
  address: { current: ReturnType<typeof browserAddress> };
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [profileMessage, setProfileMessage] = useState(0);
  const reduced = useReducedMotion();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]), [workspace, setWorkspace] = useState('');
  const [error, setError] = useState('');
  const [initialSession, setInitialSession] = useState<AgentSessionReference>();
  const [agentSetup, setAgentSetup] = useState<{workspace:string;connector?:string}>();
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const provider = query.get('connectProvider');
    if (window.spaceDesktop && workspace && workspace === (workspaceIdFromPath(location.pathname) ?? query.get('workspace')) && provider && ['codex', 'kiro', 'claude'].includes(provider)) {
      setAgentSetup({ workspace, connector: `${provider}.local` });
      const url = new URL(window.location.href);
      url.searchParams.delete('connectProvider');
      window.history.replaceState(window.history.state, '', url);
      address.current = browserAddress();
    } else setAgentSetup(undefined);
  }, [workspace]);
  const { mentionTarget, setMentionTarget, membersOpen, setMembersOpen, connection, setConnection, pageViews, viewForChannel, hubView, initialTodoId, setHubView, settingsOpen, setSettingsOpen, navigateHub, openChannel, openCollection, activityOpen, setActivityOpen, directOpen, directId, directCompose, lastHomeChannel, navigationError, mentionNavigation, openMention, openDirect, newDirect, openHome, searchOpen, setSearchOpen, setCanSearch, requestedChannel, setRequestedChannel, navigation, changeWorkspace, visit, travel, destination } = useNavigation(workspaces, workspace, setWorkspace);
  const { sidebarWidth, setSidebarWidth } = useSidebarWidth();
  const { draftState, saveDraft, uploads, forgetChannelDrafts } = attachments;
  useEffect(() => {
    if (!workspace) return;
    const outbox = getMessageOutbox(profile.id, workspace);
    const realtime = acquireRealtime();
    const resume = () => outbox.resumeDeletes();
    resume();
    realtime.on('connect', resume);
    realtime.on('focus', resume);
    window.addEventListener('online', resume);
    return () => { window.removeEventListener('online', resume); realtime.release(); };
  }, [profile.id, workspace]);
  function forgetChannel(id: string) { pageViews.rooms.delete(id); forgetChannelDrafts(id); getMessageOutbox(profile.id, workspace).purgeChannel(id); }
  const [loaded, setLoaded] = useState(false), [loadAttempt, setLoadAttempt] = useState(0);
  async function addWorkspace(name: string) {
    const created = await request<Workspace>('/workspaces', { name: name.trim() });
    setWorkspaces(items => [...items, created]);
    changeWorkspace(created.id);
  }
  useEffect(() => {
    let active = true;
    setError('');
    const url = new URL(window.location.href);
    const controller = new AbortController();
    async function load() {
      const link = url.pathname.startsWith('/c/') ? parseConversationPath(url.pathname) : undefined;
      const session = url.pathname.startsWith('/s/') ? parseSessionPath(url.pathname) : undefined;
      const [items, target, sessionLocation] = await Promise.all([
        listAll<Workspace>('/workspaces'),
        link && request<{workspace_id: string}>(`/channels/${link.channel}/location${link.thread ? `?thread=${link.thread}` : ''}`, undefined, undefined, 'POST', controller.signal),
        session ? request<AgentSessionReference & { workspace_id: string }>(`/agent-sessions/${session}/location`, undefined, undefined, undefined, controller.signal) : undefined,
      ]);
      if (!active) return;
      const workspaceLink = workspaceIdFromPath(url.pathname);
      const requested = sessionLocation?.workspace_id ?? target?.workspace_id ?? workspaceLink ?? url.searchParams.get('workspace');
      if ((link || session || requested) && !items.some(item => item.id === requested)) throw new Error('not_found');
      if ((url.pathname === '/chat' || url.pathname === '/') && requested && !url.searchParams.has('channel')) {
        const canonical = new URL(workspacePath(requested), url.origin);
        if (canonical.pathname !== '/chat') {
          url.searchParams.delete('workspace');
          canonical.search = url.search;
          canonical.hash = url.hash;
          history.replaceState(history.state, '', canonical);
          address.current = browserAddress();
        }
      }
      setWorkspaces(items);
      setWorkspace(items.find(item => item.id === requested)?.id ?? items[0]?.id ?? '');
      const segment = workspaceLink && url.pathname.split('/')[3];
      const view = segment === 'dms' ? 'DMs' : segment === 'activity' ? 'Activity' : segment || history.state?.spaceView;
      if (sessionLocation) setInitialSession(sessionLocation);
      else if (link) {
        if (view === 'DMs') openDirect(link.channel);
        else setRequestedChannel(link.channel);
        if (link.thread) setMentionTarget({channel_id: link.channel, message_id: '', thread_id: link.thread});
      } else if (view === 'DMs') openDirect();
      else if (view === 'Activity') setActivityOpen(true);
      else if (['spacebot','files','todos','agents','threads','huddles','drafts','saved','directories'].includes(view)) navigateHub(view);
      setLoaded(true);
    }
    void load().catch(reason => {
      if (active) setError((url.pathname.startsWith('/c/') || url.pathname.startsWith('/s/') || url.pathname.startsWith('/w/')) && ['not_found','forbidden'].includes(reason?.message)
        ? (url.pathname.startsWith('/s/') ? 'This agent session is unavailable to your account.' : url.pathname.startsWith('/w/') ? 'This workspace is unavailable to your account.' : 'This conversation or thread is unavailable to your account.') : errorText(reason));
    });
    return () => { active = false; controller.abort(); };
  }, [loadAttempt]);

  const view = hubView ?? (activityOpen ? 'Activity' : directOpen ? 'DMs' : 'Home');
  const firstView = useRef(true);
  const publish = useCallback((destination: string | null) => {
    if (!workspace || address.current.path !== location.pathname + location.search) return;
    const home = workspacePath(workspace);
    const path = destination ?? (view !== 'Home' && home.startsWith('/w/') ? home + '/' + view.toLowerCase() : home);
    const initial = firstView.current;
    firstView.current = false;
    // Keep profile links and desktop handoffs until their owner consumes the query.
    if (initial && [...new URLSearchParams(location.search).keys()].some(key => !['workspace','channel','message'].includes(key))) return;
    const state = { ...history.state, spaceView: view };
    if (path === address.current.path && address.current.view === view) return;
    if (initial || (path === address.current.path && destination !== null)) history.replaceState(state, '', path);
    else history.pushState(state, '', path);
    address.current = { path, view };
  }, [address, workspace, view]);
  useEffect(() => {
    if (loaded && (hubView || activityOpen)) publish(null);
  }, [loaded, hubView, activityOpen, publish]);
  if (!loaded) return error ? <AccessFrame screen="workspace-error" title="Let’s try that again."><p role="alert">{error}</p><Button onClick={() => { setError(''); setLoadAttempt(attempt => attempt + 1); }}>Try again</Button>{location.pathname !== '/chat' && <a href="/chat">Open workspace</a>}</AccessFrame> : location.pathname.startsWith('/c/') ? <ConversationLinkLoading /> : <AccessLoading message="Loading workspaces…" />;
  if (!workspace) return <WorkspaceSetup name={profile.display_name} onCreate={addWorkspace} />;
  const selectedWorkspace = workspaces.find(item => item.id === workspace);
  const recent = navigation.entries.map((entry, index) => ({ ...entry, index })).reverse().filter((entry, index, entries) => entries.findIndex(other => other.workspace === entry.workspace && other.channel === entry.channel) === index);
  function renderPreview(tab: RailPreview, close: () => void) {
    switch (tab) {
      case 'dms': return <DirectMessagesPeek workspace={workspace} viewer={profile.id} onOpen={id => { close(); openDirect(id); }}/>;
      case 'activity': return <ActivityPeek workspace={workspace} onOpen={item => { close(); void openMention(item); }}/>;
      case 'spacebot': return <SpacebotPreview workspace={workspace}
        onNewMessage={() => { close(); navigateHub('spacebot'); }}
        onOpenSession={session => { close(); onOpenSession(session); }}
        onOpenTodos={() => { close(); navigateHub('todos'); }}/>;
      case 'files':
      case 'todos': return <CollectionRailPreview view={tab} workspace={workspace}
        onOpen={target => { close(); openCollection(target); }}
        onOpenDestination={todoId => { close(); navigateHub(tab, todoId); }}/>;
    }
  }
  const hubContent = workspace && hubView ? hubView === 'drafts' ? <ComposerDrafts key={`drafts:${workspace}`} workspace={workspace} drafts={draftState.current} onOpen={openCollection} onNewMessage={newDirect}/> : ['threads','saved','files','todos'].includes(hubView) ? <WorkspaceCollections initialTodoId={initialTodoId} key={`${workspace}:${hubView}`} view={hubView as 'threads'|'saved'|'files'|'todos'} workspace={workspace} onOpen={openCollection}/> : <WorkspaceDestinations key={`${workspace}:${hubView}`} view={hubView as 'directories'|'agents'|'spacebot'|'huddles'} workspace={workspace} viewer={profile.id} onOpenChannel={openChannel} onOpenMembers={() => setMembersOpen(true)} onOpenAgents={() => navigateHub('agents')} onOpenConnection={setConnection} onConnectAgent={connector => setAgentSetup({workspace,connector})} viewState={hubView==='spacebot'?pageViews.spacebot:undefined}/> : undefined;
  return <WorkspaceQueryProvider workspace={workspace} viewer={profile.id}><ConversationLocation.Provider value={publish}><ProfileProvider workspace={workspace} viewer={profile.id} onConnection={setConnection} onMessage={(target, channel) => {
    if (target.kind === 'agent') saveDraft(channel, profileMessageDraft(target, draftState.current[channel]));
    setProfileMessage(value => value + 1); openDirect(channel);
  }}><motion.div className="access-workspace-enter" initial={reduced || location.pathname.startsWith('/c/') ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={motionTransition(reduced, .24)}><ChatShell renderPreview={renderPreview} onNavigate={workspace ? navigateHub : undefined} activeDestination={hubView && !homeShortcuts.has(hubView) ? hubView as 'spacebot'|'files'|'todos'|'agents' : undefined} adminItems={workspace ? [{ label: 'Workspace settings', onSelect: () => setSettingsOpen(true) }, { label: 'Manage members', onSelect: () => setMembersOpen(true) }, { label: 'Apps & agents', onSelect: () => navigateHub('agents') }] : undefined} onActivity={workspace ? () => { mentionNavigation.current++; setHubView(undefined); setActivityOpen(true); setSearchOpen(false); setCanSearch(false); } : undefined} activityActive={activityOpen} notificationDelivery={{workspace,channel:activityOpen?'*':hubView?undefined:directOpen?directId:lastHomeChannel.current,onOpen:item=>void openMention(item)}} onHome={openHome} onDirectMessages={workspace ? () => openDirect() : undefined} directMessagesActive={directOpen && !activityOpen} activity={workspace ? <MentionInbox key={workspace} workspace={workspace} onOpen={item => void openMention(item)} /> : undefined} name={selectedWorkspace?.name ?? 'Space'} user={profile.display_name} userId={profile.id} onNameChange={name => setProfile(old => old.display_name === name ? old : { ...old, display_name: name })} workspaces={workspaces} workspace={workspace} onWorkspaceChange={workspaces.length ? changeWorkspace : undefined} onCreateWorkspace={addWorkspace} sidebarWidth={sidebarWidth} onBack={navigation.index > 0 ? () => travel(navigation.index - 1) : undefined} onForward={navigation.index < navigation.entries.length - 1 ? () => travel(navigation.index + 1) : undefined} history={recent.map(entry => ({ label: entry.label, onSelect: () => travel(entry.index) }))} onMembers={workspace ? () => setMembersOpen(true) : undefined} onSearch={workspace ? () => setSearchOpen(true) : undefined}>
    {workspace && <MessageSearch workspace={workspace} open={searchOpen} onClose={() => setSearchOpen(false)} onSelect={result => void openMention({channel_id:result.channel_id,message_id:result.id,...(result.is_reply ? {thread_id:result.thread_id} : {})})}/> }
    {workspace && agentSetup?.workspace === workspace && <WorkspaceMembers workspace={workspace} viewer={profile.id} initialConnector={agentSetup.connector} open onClose={() => setAgentSetup(undefined)}/>}
    {workspace && connection && <WorkspaceMembers workspace={workspace} viewer={profile.id} agent={connection} open onClose={()=>setConnection(undefined)}/>}
    {workspace && <WorkspaceAdministration key={`members:${workspace}`} workspace={workspace} viewer={profile.id} open={membersOpen} onClose={() => setMembersOpen(false)} />}
    {workspace && <WorkspaceSettings onManageMembers={() => { setSettingsOpen(false); setMembersOpen(true); }} key={workspace} workspace={workspace} open={settingsOpen} onClose={() => setSettingsOpen(false)} onRenamed={name => setWorkspaces(old => old.map(item => item.id === workspace ? {...item,name} : item))}/>}
    {error && <p role="alert">{error}</p>}
    {navigationError && <p role="alert">{navigationError}</p>}
    <DestinationTransition destination={destination} scope={workspace}>
    {workspace && hubView && !homeShortcuts.has(hubView) ? hubContent : workspace && activityOpen ? <Notifications viewState={pageViews.activity} key={`activity:${workspace}`} workspace={workspace} onOpen={item => void openMention(item)}/> : workspace && directOpen ? <DirectMessages viewState={pageViews.direct} key={`dms:${workspace}`} workspace={workspace} viewer={profile.id} requestedId={directId} compose={directCompose} width={sidebarWidth} drafts={draftState.current} onDraftChange={saveDraft} onVisit={visit} onSearchAvailabilityChange={setCanSearch} renderConversation={(dm, controls) => <ChannelRoom viewState={viewForChannel(dm.id)} key={`${dm.id}:${profileMessage}`} readState={controls.readState} uploads={uploads} profile={profile} channel={dm} onChannelChange={updated => controls.change(updated as DirectMessageSummary)} onLeft={() => void controls.close()} onCloseDirect={() => void controls.close()} drafts={draftState.current} onDraftChange={saveDraft} onAccessLost={() => forgetChannel(dm.id)} searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} composeRequest={profileMessage} requestedThread={mentionTarget?.channel_id === dm.id ? mentionTarget.thread_id : undefined} mentionTarget={mentionTarget?.channel_id === dm.id ? mentionTarget.message_id : undefined} onMentionOpened={() => setMentionTarget(undefined)} />} /> : workspace ? <WorkspaceChannels initialSession={initialSession} onSessionRestored={() => setInitialSession(undefined)} viewForChannel={viewForChannel} onRequestedChannelConsumed={() => setRequestedChannel(undefined)} shortcut={hubView} onShortcut={navigateHub} content={hubContent} onContentClose={() => setHubView(undefined)} onDirectMessage={openChannel} onNewDirectMessage={newDirect} uploads={uploads} profile={profile} workspace={workspace} workspaces={workspaces} workspaceControl={selectedWorkspace && <WorkspaceActions key={workspace} workspace={selectedWorkspace} onSettings={() => setSettingsOpen(true)} onMembers={() => setMembersOpen(true)} />} width={sidebarWidth} onWidthChange={setSidebarWidth} requestedChannel={requestedChannel} mentionTarget={mentionTarget} onMentionOpened={() => setMentionTarget(undefined)} onVisit={visit} searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} onSearchAvailabilityChange={setCanSearch} drafts={draftState.current} onDraftChange={saveDraft} onForgetChannel={forgetChannel} /> : null}
    </DestinationTransition>
  </ChatShell></motion.div></ProfileProvider></ConversationLocation.Provider></WorkspaceQueryProvider>;
}
