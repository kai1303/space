import { DestinationTransition } from './navigation/DestinationTransition.js';
import { WorkspaceMembers } from '../features/workspace/members/WorkspaceMembers.js';
import { WorkspaceSettings } from '../features/workspace/settings/WorkspaceSettings.js';
import { WorkspaceCollections } from '../features/workspace/collections/WorkspaceCollections.js';
import { WorkspaceDestinations } from '../features/workspace/collections/WorkspaceDestinations.js';
import { ComposerDrafts } from '../features/composer/ComposerDrafts.js';
import { Notifications } from '../features/notifications/Notifications.js';
import { DirectMessages } from '../features/direct-messages/DirectMessages.js';
import { MentionInbox } from "../features/mentions/Mentions.js";
import { WorkspaceAdministration } from '../features/workspace/members/WorkspaceAdministration.js';
import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { motionTransition } from '@space/ui/motion';
import { AccessFrame, AccessLoading } from '../features/auth/AccessFrame.js';
import { WorkspaceSetup } from '../features/workspace/onboarding/WorkspaceSetup.js';
import type { DirectMessageSummary } from '@space/contracts';
import { Button } from '@space/ui/primitives';
import { listAll, request } from '../shared/api/request.js';
import { ChatShell, WorkspacePicker } from './shell/ChatShell.js';
import type { Workspace } from '../features/workspace/workspace-types.js';
import type { Profile } from '../features/profile/profile-types.js';
import { homeShortcuts } from '../features/workspace/collections/hub-view.js';
import { errorText } from '../shared/api/error-text.js';
import { WorkspaceChannels } from '../features/channels/WorkspaceChannels.js';
import { ChannelRoom } from '../features/chat/ChannelRoom.js';
import { MessageSearch } from '../features/search/MessageSearch.js';
import { useNavigation } from './navigation/useNavigation.js';
import { useSidebarWidth } from './shell/useSidebarWidth.js';
import { useAttachmentUploads } from '../features/composer/useAttachmentUploads.js';

export function ChatWorkspace({ profile: initialProfile }: { profile: Profile }) {
  const [profile, setProfile] = useState(initialProfile);
  const reduced = useReducedMotion();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]), [workspace, setWorkspace] = useState('');
  const [error, setError] = useState('');
  const [agentSetup, setAgentSetup] = useState<{workspace:string;connector?:string}>();
  useEffect(() => { setAgentSetup(undefined); }, [workspace]);
  const { mentionTarget, setMentionTarget, membersOpen, setMembersOpen, connection, setConnection, pageViews, viewForChannel, hubView, setHubView, settingsOpen, setSettingsOpen, navigateHub, openChannel, openCollection, activityOpen, setActivityOpen, directOpen, directId, directCompose, lastHomeChannel, navigationError, mentionNavigation, openMention, openDirect, newDirect, openHome, searchOpen, setSearchOpen, setCanSearch, requestedChannel, setRequestedChannel, navigation, changeWorkspace, visit, travel, destination } = useNavigation(workspaces, workspace, setWorkspace);
  const { sidebarWidth, setSidebarWidth } = useSidebarWidth();
  const { draftState, saveDraft, uploads, forgetChannelDrafts } = useAttachmentUploads(profile.id);
  function forgetChannel(id: string) { pageViews.rooms.delete(id); forgetChannelDrafts(id); }
  const [loaded, setLoaded] = useState(false), [loadAttempt, setLoadAttempt] = useState(0);
  async function addWorkspace(name: string) {
    const created = await request<Workspace>('/workspaces', { name: name.trim() });
    setWorkspaces(items => [...items, created]);
    changeWorkspace(created.id);
  }
  useEffect(() => {
    let active = true;
    setError('');
    void listAll<Workspace>('/workspaces').then(items => { if (active) { const requested = new URLSearchParams(window.location.search).get('workspace'); setWorkspaces(items); setWorkspace(items.find(item => item.id === requested)?.id ?? items[0]?.id ?? ''); setLoaded(true); } }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [loadAttempt]);
  if (!loaded) return error ? <AccessFrame screen="workspace-error" title="Let’s try that again."><p role="alert">{error}</p><Button onClick={() => { setError(''); setLoadAttempt(attempt => attempt + 1); }}>Try again</Button></AccessFrame> : <AccessLoading message="Loading workspaces…" />;
  if (!workspace) return <WorkspaceSetup name={profile.display_name} onCreate={addWorkspace} />;
  const selectedWorkspace = workspaces.find(item => item.id === workspace);
  const recent = navigation.entries.map((entry, index) => ({ ...entry, index })).reverse().filter((entry, index, entries) => entries.findIndex(other => other.workspace === entry.workspace && other.channel === entry.channel) === index);
  const hubContent = workspace && hubView ? hubView === 'drafts' ? <ComposerDrafts key={`drafts:${workspace}`} workspace={workspace} drafts={draftState.current} onOpen={openCollection} onNewMessage={newDirect}/> : ['threads','saved','files','todos'].includes(hubView) ? <WorkspaceCollections key={`${workspace}:${hubView}`} view={hubView as 'threads'|'saved'|'files'|'todos'} workspace={workspace} onOpen={openCollection}/> : <WorkspaceDestinations key={`${workspace}:${hubView}`} view={hubView as 'directories'|'agents'|'spacebot'|'huddles'} workspace={workspace} viewer={profile.id} onOpenChannel={openChannel} onOpenMembers={() => setMembersOpen(true)} onOpenAgents={() => navigateHub('agents')} onOpenConnection={setConnection} onConnectAgent={connector => setAgentSetup({workspace,connector})} viewState={hubView==='spacebot'?pageViews.spacebot:undefined}/> : undefined;
  return <motion.div className="access-workspace-enter" initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={motionTransition(reduced, .24)}><ChatShell onNavigate={workspace ? navigateHub : undefined} activeDestination={hubView && !homeShortcuts.has(hubView) ? hubView as 'spacebot'|'files'|'todos'|'agents' : undefined} adminItems={workspace ? [{ label: 'Workspace settings', onSelect: () => setSettingsOpen(true) }, { label: 'Manage members', onSelect: () => setMembersOpen(true) }, { label: 'Apps & agents', onSelect: () => navigateHub('agents') }] : undefined} onActivity={workspace ? () => { mentionNavigation.current++; setHubView(undefined); setActivityOpen(true); setSearchOpen(false); setCanSearch(false); } : undefined} activityActive={activityOpen} notificationDelivery={{workspace,channel:activityOpen?'*':hubView?undefined:directOpen?directId:lastHomeChannel.current,onOpen:item=>void openMention(item)}} onHome={openHome} onDirectMessages={workspace ? () => openDirect() : undefined} directMessagesActive={directOpen && !activityOpen} activity={workspace ? <MentionInbox key={workspace} workspace={workspace} onOpen={item => void openMention(item)} /> : undefined} name={selectedWorkspace?.name ?? 'Space'} user={profile.display_name} userId={profile.id} onNameChange={name => setProfile(old => old.display_name === name ? old : { ...old, display_name: name })} workspaces={workspaces} workspace={workspace} onWorkspaceChange={workspaces.length ? changeWorkspace : undefined} onCreateWorkspace={addWorkspace} sidebarWidth={sidebarWidth} onBack={navigation.index > 0 ? () => travel(navigation.index - 1) : undefined} onForward={navigation.index < navigation.entries.length - 1 ? () => travel(navigation.index + 1) : undefined} history={recent.map(entry => ({ label: entry.label, onSelect: () => travel(entry.index) }))} onMembers={workspace ? () => setMembersOpen(true) : undefined} onSearch={workspace ? () => setSearchOpen(true) : undefined}>
    {workspace && <MessageSearch workspace={workspace} open={searchOpen} onClose={() => setSearchOpen(false)} onSelect={result => void openMention({channel_id:result.channel_id,message_id:result.id,...(result.is_reply ? {thread_id:result.thread_id} : {})})}/> }
    {workspace && agentSetup?.workspace === workspace && <WorkspaceMembers workspace={workspace} viewer={profile.id} initialConnector={agentSetup.connector} open onClose={() => setAgentSetup(undefined)}/>}
    {workspace && connection && <WorkspaceMembers workspace={workspace} viewer={profile.id} agent={connection} open onClose={()=>setConnection(undefined)}/>}
    {workspace && <WorkspaceAdministration key={`members:${workspace}`} workspace={workspace} viewer={profile.id} open={membersOpen} onClose={() => setMembersOpen(false)} />}
    {workspace && <WorkspaceSettings onManageMembers={() => { setSettingsOpen(false); setMembersOpen(true); }} key={workspace} workspace={workspace} open={settingsOpen} onClose={() => setSettingsOpen(false)} onRenamed={name => setWorkspaces(old => old.map(item => item.id === workspace ? {...item,name} : item))}/>}
    {error && <p role="alert">{error}</p>}
    {navigationError && <p role="alert">{navigationError}</p>}
    <DestinationTransition destination={destination} scope={workspace}>
    {workspace && hubView && !homeShortcuts.has(hubView) ? hubContent : workspace && activityOpen ? <Notifications viewState={pageViews.activity} key={`activity:${workspace}`} workspace={workspace} onOpen={item => void openMention(item)}/> : workspace && directOpen ? <DirectMessages viewState={pageViews.direct} key={`dms:${workspace}`} workspace={workspace} viewer={profile.id} requestedId={directId} compose={directCompose} width={sidebarWidth} drafts={draftState.current} onDraftChange={saveDraft} onVisit={visit} onSearchAvailabilityChange={setCanSearch} renderConversation={(dm, controls) => <ChannelRoom viewState={viewForChannel(dm.id)} key={dm.id} readState={controls.readState} uploads={uploads} profile={profile} channel={dm} onChannelChange={updated => controls.change(updated as DirectMessageSummary)} onLeft={() => void controls.close()} onCloseDirect={() => void controls.close()} drafts={draftState.current} onDraftChange={saveDraft} onAccessLost={() => forgetChannel(dm.id)} searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} composeRequest={0} requestedThread={mentionTarget?.channel_id === dm.id ? mentionTarget.thread_id : undefined} mentionTarget={mentionTarget?.channel_id === dm.id ? mentionTarget.message_id : undefined} onMentionOpened={() => setMentionTarget(undefined)} />} /> : workspace ? <WorkspaceChannels viewForChannel={viewForChannel} onRequestedChannelConsumed={() => setRequestedChannel(undefined)} shortcut={hubView} onShortcut={navigateHub} content={hubContent} onContentClose={() => setHubView(undefined)} onDirectMessage={openChannel} onNewDirectMessage={newDirect} uploads={uploads} profile={profile} workspace={workspace} workspaces={workspaces} workspaceControl={<WorkspacePicker items={workspaces} value={workspace} onChange={changeWorkspace} onMembers={() => setMembersOpen(true)} />} width={sidebarWidth} onWidthChange={setSidebarWidth} requestedChannel={requestedChannel} mentionTarget={mentionTarget} onMentionOpened={() => setMentionTarget(undefined)} onVisit={visit} searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} onSearchAvailabilityChange={setCanSearch} drafts={draftState.current} onDraftChange={saveDraft} onForgetChannel={forgetChannel} /> : null}
    </DestinationTransition>
  </ChatShell></motion.div>;
}
