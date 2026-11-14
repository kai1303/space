import { ConversationMain, FrameHeader } from './ConversationFrame.js';
import {encryptedTransfer, fileManifest} from '../direct-messages/encryption/encrypted-upload.js';
import {encryptedMessageLabel} from '@space/contracts';
import {ComposerSendError, RichComposer} from '@space/ui/composer';
import {EncryptedBody,EncryptedSearch,EncryptionSettings,useDmEncryption} from '../direct-messages/encryption/DmEncryption.js';
import { conversationPath, parseConversationPath, sessionPath } from '@space/contracts';
import { usePublishedPath } from '../../shared/ui/conversation-location.js';
import { useMemberProfile } from '../profile/MemberProfile.js';
import { HuddleButton } from '../huddles/Huddles.js';
import { Sidekick } from '../agents/Sidekick.js';
import type { SidekickSource } from '@space/contracts';
import { CallButtons } from '../calling/Calling.js';
import type { Snapshot } from '../../shared/ui/view-state.js';
import type { ConversationView } from './view-state.js';
import { ConversationSectionMenu } from '../channels/ConversationSectionMenu.js';
import { ThreadNotificationToggle } from '../notifications/Notifications.js';
import { ConversationHeader, ConversationComposer, ConversationMessage, continuesMessageGroup, ConversationNavigation, ConversationIntroduction } from './ThreadConversation.js';
import { readAgentResponse } from '../agents/AgentMessageBody.js';
import { AgentSessions } from '../agents/AgentSessions.js';
import { TypingIndicator, useTypingPublisher } from './typing.js';
import { acquireRealtime } from '../../shared/realtime/socket-session.js';
import { MentionDetails, useMentionSearch } from "../mentions/Mentions.js";
import { NavigatorSettings, NavigatorSuggestions, agentMention } from '../agents/Navigator.js';
import { MessageTimeline, type TimelineHandle } from './MessageTimeline.js';
import { SessionReports, useSessionReports } from './SessionReports.js';
import {useSavedMessages} from './useSavedMessages.js';
import {invalidateUpdates} from '../../shared/realtime/live-updates.js';
import {workspacePath} from '@space/contracts';
import { useMessageHistory } from './useMessageHistory.js';
import { ConversationPanelDivider } from './ConversationPanelDivider.js';
import { useConversationPanels } from './useConversationPanels.js';
import { useChannelRead } from './useChannelRead.js';
import { ChannelTabMenu, useChannelTabs } from '../channels/ChannelTabs.js';
import { ChannelResources } from '../files/ChannelResources.js';
import { ChannelFiles } from '../files/ChannelFiles.js';
import { ChannelMemory } from '../memory/ChannelMemory.js';
import { ChannelPins, useChannelPins } from './ChannelPins.js';
import { SourceMessage } from './SourceMessage.js';
import { useChannelPermissions } from '../channels/useChannelPermissions.js';
import { ChannelDetails } from '../channels/ChannelDetails.js';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { AnimatePresence } from 'motion/react';
import type { ChannelUnread, MentionReference, NavigatorCandidate, ChatEvent, ChatHistory, ChatMessage, DirectMessageSummary } from '@space/contracts';
import { Avatar, Button, Dialog, IconButton, Menu, SidePanel, toast } from '@space/ui/primitives';
import { ConversationHeading, ConversationDateDivider, useMessageArrivals } from '@space/ui/conversation';
import { MessageSearch } from '../search/MessageSearch.js';
import { type RichDocument } from '@space/ui/rich-text';
import { ArrowSquareOut, Archive, BookmarkSimple, CaretLeft, ChatCircle, DotsThree, Hash, Lock, MagnifyingGlass, Paperclip, Robot, Users, X, Check } from '@phosphor-icons/react';
import { ConversationListContext } from '../../shared/ui/conversation-list.js';
import { scheduleMessage } from '../composer/scheduled-messages.js';
import { socketCommand as command } from '../../shared/realtime/socket-command.js';
import { mergeEvents } from './merge-events.js';
import { getMessageOutbox, type OutboxEntry } from '../composer/message-outbox.js';
import { OutgoingMessage, OutgoingMessages, useOutgoingMessages } from '../composer/OutgoingMessages.js';
import type { Attachment } from '@space/ui/rich-text';
import { request } from '../../shared/api/request.js';
import type { ChannelSummary as Channel } from '@space/contracts';
import type { Profile } from '../profile/profile-types.js';
import { errorText } from '../../shared/api/error-text.js';
import { ConversationLoadingStatus } from './ConversationLoading.js';
import { ConversationSkeleton } from './ConversationSkeleton.js';
import { ThreadHistory } from './ThreadHistory.js';
import { ThreadComposer } from '../composer/ThreadComposer.js';
import { type UploadDrafts } from '../composer/useAttachmentUploads.js';

export function ChannelRoom({ onOpenCodeChannel, threadOnly, viewState, draftRevision, editDraftKey, requestedThread, onCloseDirect, readState, uploads, profile, channel, onChannelChange, onLeft, drafts, onDraftChange, onAccessLost, searchOpen, composeRequest, mentionTarget, onMentionOpened }: { onOpenCodeChannel?:(thread:string,id:string,artifact?:NonNullable<import('@space/contracts').SessionReport['artifact']>)=>void; threadOnly?: { close:()=>void; detached?:boolean }; draftRevision?: number; editDraftKey?: string; viewState?:Snapshot<ConversationView>; requestedThread?: string; onCloseDirect?: () => void; readState?: ChannelUnread; uploads: UploadDrafts; profile: Profile; channel: Channel; onChannelChange: (channel: Channel) => void; onLeft: () => void; drafts: Record<string, RichDocument>; onDraftChange: (key: string, document: RichDocument) => void; onAccessLost: () => void; searchOpen: boolean; onSearchClose: () => void; composeRequest: number; mentionTarget?: string; onMentionOpened: () => void }) {
  const profiles = useMemberProfile();
  const [selection,setSelection]=useState<string[]|undefined>();
  const panels = useConversationPanels(viewState, requestedThread, mentionTarget, !!editDraftKey);
  const {sidekick, thread, sessionView, sessionOpen, filesOpen, threadPanel, sessionPanel, sidekickPanel} = panels;
  const openSessions=onOpenCodeChannel ?? panels.openSessions;
  useEffect(()=>setSelection(undefined),[channel.id]);
  function discuss(source:SidekickSource){panels.openSidekick(source);setSelection(undefined);}
  const selectionBar=selection&&<div className="sidekick-selection" role="region" aria-label="Selected messages"><strong>{selection.length} selected</strong><span className="sidekick-selection-hint">Click messages to select</span><Button size="sm" disabled={!selection.length} onClick={()=>discuss({channel_id:channel.id,message_ids:selection})}>Discuss with agent</Button><Button size="sm" variant="ghost" onClick={()=>setSelection(undefined)}>Cancel selection</Button></div>;
  const direct = channel.kind === 'direct' ? channel as DirectMessageSummary : undefined;
  const encryption=useDmEncryption(direct,profile.id);
  const encrypted=encryption.enabled;
  const uploadKey=encrypted ? `encrypted:${channel.id}` : channel.id;
  const transfer=encrypted ? encryptedTransfer(profile.id) : undefined;
  const encryptionUnchecked=!!direct && encryption.loading;
  const draftLocked = encrypted && (!!uploads.lockedDrafts?.[uploadKey] || !encryption.draftKeyReady);
  const draftUnavailable = encryptionUnchecked || draftLocked;
  const permissions = useChannelPermissions(direct ? undefined : channel.id, channel.workspace_id);
  const checkingPermissions = !direct && !permissions.snapshot && !permissions.error;
  const permissionUnavailable = permissions.error || undefined;
  const outbox = useMemo(() => getMessageOutbox(profile.id, channel.workspace_id), [profile.id, channel.workspace_id]);
  const postDisabledReason = direct ? encryption.loading ? 'Checking conversation encryption…' : encrypted && (!encryption.enrolled || !encryption.verified || !encryption.complete) ? 'Verify your devices in conversation details to send.' : undefined : !permissions.snapshot ? permissionUnavailable : permissions.snapshot.capabilities.post ? undefined : 'You can read this channel, but posting is restricted.';
  const replyDisabledReason = direct ? undefined : !permissions.snapshot ? permissionUnavailable : permissions.snapshot.capabilities.reply ? undefined : 'You can read this thread, but replies are restricted.';
  const selfDirect = direct?.participants.length === 1 && direct.participants[0]?.id === profile.id;
  const findMentions = useMentionSearch(channel.id);
  const [selectedMention, setSelectedMention] = useState<MentionReference>();
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
  const pins = useChannelPins(!direct && status !== 'Disconnected' ? channel.id : undefined, profile.id);
  const tabs = useChannelTabs(!direct && status !== 'Disconnected' ? channel.id : undefined, profile.id);
  const showFilesTab = tabs.visible('files');
  const showPinsTab = tabs.visible('pins');
  useEffect(() => {
    if (!direct && filesOpen && !showFilesTab) panels.close();
    if (pins.open && !showPinsTab) pins.close();
  }, [direct, filesOpen, showFilesTab, pins.open, showPinsTab]);
  const [ready, setReady] = useState(false);
  const [attachmentRevision, setAttachmentRevision] = useState('0');
  const [socket, setSocket] = useState<Socket>();
  const [navCandidates,setNavCandidates]=useState<NavigatorCandidate[]>([]);
  const agentTags=[...new Set(navCandidates.map(c=>agentMention(c,navCandidates)))];
  const [channelSearchRequest, setChannelSearchRequest] = useState(0), [detailsOpen, setDetailsOpen] = useState(false);
  const channelSearchOpen = channelSearchRequest > 0;
  const [searchMatch, setSearchMatch] = useState<{ id: string; thread?: string }>();
  const searchButton = useRef<HTMLButtonElement>(null);
  function closeChannelSearch() {
    setChannelSearchRequest(0);
    setSearchMatch(undefined);
    searchButton.current?.focus();
  }
  const [detailsTab, setDetailsTab] = useState('about');
  const showDetails = (tab = 'about') => { setDetailsTab(tab); setDetailsOpen(true); };
  const filesButton = useRef<HTMLButtonElement>(null);
  const channelTyping=useTypingPublisher(socket,channel.id,undefined,ready&&!channel.archived_at&&!sessionOpen&&!(compact&&thread));
  useEffect(() => {
    if (editDraftKey) {
      if (!requestedThread) panels.close();
      else if (thread !== requestedThread) panels.openThread(requestedThread);
    } else if (requestedThread) {
      panels.openThread(requestedThread);
      onMentionOpened();
    }
  }, [requestedThread, editDraftKey]);
  function openThread(id: string) {
    setSourceId(null);
    panels.openThread(id);
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
  const memoryDirty = useRef(false), trackMemoryDirty = useCallback((dirty: boolean) => { memoryDirty.current = dirty; }, []);
  // Memory is a channel tab in place of the messages, so it closes Pins and Files when it opens.
  function showMemory(message?: { id: string; text: string }) {
    pins.close(); if (filesOpen) panels.close();
    setMemoryMessage(message); setMemoryOpen(true);
  }
  // Leaving the Memory tab asks first when an editor has unsaved edits. Returns false to stay.
  function leaveMemory() {
    if (!memoryOpen) return true;
    if (memoryDirty.current && !window.confirm('Discard your unsaved memory edits?')) return false;
    memoryDirty.current = false; setMemoryOpen(false); setMemoryMessage(undefined);
    return true;
  }
  const [sourceId, setSourceId] = useState(() => {
    if (mentionTarget) return mentionTarget;
    const params = new URLSearchParams(window.location.search);
    if (location.pathname.startsWith('/c/')) {
      const link = parseConversationPath(location.pathname);
      if (link.channel === channel.id && link.message) return link.message;
    }
    return params.get('channel') === channel.id ? params.get('message') : null;
  });
  const [linkedMessage, setLinkedMessage] = useState<ChatMessage>();
  const target = linkedMessage?.id === sourceId ? linkedMessage : undefined;
  const linkedReply = !!target?.thread_root_id && target.thread_root_id !== target.id;
  const disconnected = status === 'Disconnected';
  useEffect(() => {
    if (!sourceId || disconnected) return;
    let active = true;
    void request<ChatMessage>(`/channels/${channel.id}/messages/${encodeURIComponent(sourceId)}`).then(message => {
      if (!active) return;
      setLinkedMessage(message);
      pins.close();
      setMemoryOpen(false);
      if (message.agent_session_id) openSessions(message.thread_id, message.agent_session_id);
      else if (message.thread_root_id && message.thread_root_id !== message.id) panels.openThread(message.thread_id);
      else panels.close();
    }).catch(reason => {
      if (!active) return;
      setError(errorText(reason));
      setSourceId(null);
      if (reason instanceof Error && ['unauthorized','not_found','forbidden'].includes(reason.message)) checkSourceAccess();
    });
    return () => { active = false; };
  }, [channel.id, sourceId, disconnected]);
  useEffect(() => { if (mentionTarget) { setSourceId(mentionTarget); onMentionOpened(); } }, [mentionTarget, onMentionOpened]);
  useEffect(() => {
    if (!composeRequest) return;
    panels.close();
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('#chat-messages .ql-editor')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [composeRequest]);
  useEffect(() => { if (searchOpen && (filesOpen || sessionOpen)) panels.close(); }, [searchOpen]);
  useEffect(() => {
    if (thread || sessionOpen || filesOpen || sidekick) {
      setChannelSearchRequest(0);
      setSearchMatch(undefined);
    }
  }, [thread, sessionOpen, filesOpen, sidekick]);
  const accessLost = useRef(onAccessLost); accessLost.current = onAccessLost;
  const revokeAccess = useRef<(reason: unknown) => void>(() => {});
  const cursor = useRef('0'), accessVersion = useRef(0);
  const timeline = useRef<TimelineHandle | null>(null), stickToBottom = useRef(true);
  const [deleteId, setDeleteId] = useState<string>();
  const [editing, setEditing] = useState<ChatMessage>();
  const filesDeleted = useRef<((ids: ReadonlySet<string>) => void) | null>(null);
  const activeThread = useRef(thread);
  activeThread.current = thread;
  const [replyRevision, setReplyRevision] = useState('0');
  const threadLive = useRef<((messages: ChatMessage[], sent?: boolean) => void) | null>(null);
  const openConversationList = useContext(ConversationListContext);
  const history = useMessageHistory(`/channels/${channel.id}/messages`, reason => {
    if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) revokeAccess.current(reason);
    else setError(errorText(reason));
  }, true, linkedReply ? undefined : target);
  const reports = useSessionReports(status === 'Disconnected' ? '' : channel.id, profile.id, history.page?.messages, thread);
  useEffect(() => {
    let active = true, terminal = false, initialized = false, subscribing = false, resubscribe = false, generation = 0;
    const connection = acquireRealtime(), client = connection.socket;
    setSocket(client);
    const revoke = (reason: unknown) => {
      if (terminal) return;
      terminal = true; accessVersion.current++; void outbox.purgeChannel(channel.id).catch(reason => setError(errorText(reason)));
      if (active) {
        accessLost.current(); setError(errorText(reason)); setReady(false); history.clear(); setEvents([]);
        panels.clear(); setChannelSearchRequest(0); setSearchMatch(undefined); setSourceId(null); setSelectedMention(undefined);
        setSelection(undefined);setMemoryOpen(false); setMemoryMessage(undefined); setEditing(undefined); setStatus('Disconnected');
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
    const stopDelivery = outbox.onDelivered((saved, threadReply) => {
      if (active && !terminal && saved.channel_id === channel.id) acceptDelivery(saved, threadReply);
    });
    connection.on('chat.events', (batch: { channel_id: string; events: ChatEvent[]; cursor: string }) => {
      if (active && initialized && !terminal && batch.channel_id === channel.id) {
        const incoming = batch.events.flatMap(event => (event.type === 'message.created' || event.type === 'message.updated') ? [{ ...event.payload, sequence: event.payload.sequence ?? event.sequence }] : []);
        const latestReply = batch.events.filter(event => event.type === 'message.created' && event.thread_id === activeThread.current && !event.payload.agent_session_id).at(-1);
        if (latestReply) setReplyRevision(latestReply.sequence);
        const outgoing = outbox.getSnapshot();
        history.receive(incoming, stickToBottom.current); threadLive.current?.(incoming);
        for (const saved of incoming) {
          if (saved.author.id !== profile.id || !saved.client_message_id) continue;
          const entry = outgoing.find(row => row.channelId === channel.id && row.id === saved.client_message_id);
          if (entry && (entry.status === 'sending' || entry.status === 'failed')) acceptDelivery(saved, !!entry.threadId);
        }
        void outbox.reconcile(incoming)?.catch(reason => setError(errorText(reason)));
        if (incoming.some(message => message.author.id !== profile.id && message.document?.ops.some(op => op.attributes?.mention))) window.dispatchEvent(new Event('space:mentions-changed'));
        const deleted = incoming.filter(message => message.deleted_at);
        if (deleted.length) applyDeletions(deleted);
        const attachmentEvent = batch.events.filter(event => event.type !== 'task.event' && (event.payload.attachments?.length || event.payload.deleted_at)).at(-1);
        if (attachmentEvent) setAttachmentRevision(attachmentEvent.sequence);
        setEvents(old => recentTasks(mergeEvents(old, batch.events.filter(event => event.type === 'task.event'))));
        cursor.current = batch.cursor;
        return true;
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
      stopDelivery(); active = false; accessVersion.current++; revokeAccess.current = () => {};
      if (client.connected) void command(client, 'channel.unsubscribe', { channel_id: channel.id }).catch(() => {});
      connection.release();
    };
  }, [channel.id, channel.workspace_id, historyAttempt]);
  const [atEnd, setAtEnd] = useState(true);
  const entryRead = useRef<string | undefined>(undefined);
  if (entryRead.current === undefined && readState) entryRead.current = readState.last_read_sequence;
  const messages = history.page?.messages ?? [];
  const bookmarks = useSavedMessages(channel.workspace_id,channel.id,profile.id,messages);
  const readError = useChannelRead(channel.id, history.page?.newer_cursor ?? '0', readState?.last_read_sequence,
    !threadOnly && historyLoaded && ready && !history.loading && !history.page?.has_newer && atEnd && !pins.open && !searchOpen && !filesOpen && (!sourceId || (!!target && !linkedReply)) && !detailsOpen && !memoryOpen && !selectedMention && !profiles?.selected && !(compact && sessionOpen) && !sidekick);
  const firstUnread = entryRead.current === undefined ? undefined : messages.find(message => message.author.id !== profile.id && BigInt(message.sequence ?? '0') > BigInt(entryRead.current!))?.id;
  const [sendVersion, setSendVersion] = useState(0);
  const pending = useOutgoingMessages({ outbox, profile, channel: channel.id, history: messages });
  const ownAuthor = { kind: 'human' as const, id: profile.id, name: profile.display_name };
  const livePosts: ChatMessage[] = [];
  if (!direct && historyLoaded && !history.page?.has_newer && status !== 'Disconnected') {
    const postedThreads = new Set(messages.map(message => message.thread_id));
    for (const event of events) {
      if (event.type !== 'task.event' || event.payload.type !== 'execution.progress' || event.payload.data.session_managed ||
        typeof event.payload.data.channel_post_author !== 'string' || postedThreads.has(event.thread_id)) continue;
      const response = readAgentResponse(event.payload.data.response);
      if (!response || !(response.messages.length || response.components.length || response.tools.length)) continue;
      livePosts.push({ id: event.payload.task_id, channel_id: channel.id, thread_id: event.thread_id, task_id: event.payload.task_id,
        author: { kind: 'agent', id: event.payload.installation_id, name: event.payload.data.channel_post_author },
        text: '', created_at: event.occurred_at, client_message_id: null, agent_response: response });
    }
  }
  const rows = [
    ...messages.concat(livePosts).map(message => ({
      streaming: livePosts.includes(message),
      id: message.author.kind === 'human' && message.author.id === profile.id && message.client_message_id
        ? `outgoing:${message.client_message_id}` : message.task_id && message.agent_response ? `reply:${message.task_id}` : `message:${message.id}`,
      messageId: message.id, message, author: message.author, created_at: message.created_at,
    })),
    ...(historyLoaded && status !== 'Disconnected' ? pending : []).map(entry => ({
      id: `${entry.status === 'deleting' || entry.status === 'delete_failed' ? 'cancel' : 'outgoing'}:${entry.id}`,
      entry, author: ownAuthor, created_at: entry.createdAt,
    })),
  ];
  const arrivals = useMessageArrivals(rows, historyLoaded && !history.loading ? channel.id : null);
  const conversations = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const entries = conversations.get(message.thread_id) ?? [];
    entries.push(message); conversations.set(message.thread_id, entries);
  }
  function reveal(id: string) {
    setSourceId(null);
    panels.close();

    requestAnimationFrame(() => timeline.current?.reveal(id));
  }
  function closeFiles() { panels.close(); requestAnimationFrame(() => (filesButton.current ?? document.querySelector<HTMLButtonElement>('#chat-messages [role="tab"][aria-controls="channel-shared-content"]'))?.focus()); }
  function toggleFiles() {
    pins.close();
    if (filesOpen) { closeFiles(); return; }
    panels.openFiles();
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
  function acceptDelivery(saved: ChatMessage, threadReply: boolean) {
    if (threadReply) {
      history.receive([saved], stickToBottom.current);
      threadLive.current?.([saved], true);
    } else history.receive([saved], stickToBottom.current);
    window.dispatchEvent(new Event('space:mentions-changed'));
  }
  function deliver(entry: OutboxEntry, confirmBroadcast = false) {
    const version = accessVersion.current;
    void outbox.send(entry.id, socket, confirmBroadcast || entry.broadcastConfirmed).catch(reason => {
      if (version === accessVersion.current) setError(errorText(reason));
    });
  }
  // Scheduling follows the same posting rules as sending now; the server re-checks them at send time.
  function canSchedule(threadId: string | undefined) {
    return !encrypted && !encryptionUnchecked && !checkingPermissions && !channel.archived_at && !(threadId ? replyDisabledReason : postDisabledReason);
  }
  async function submit(threadId: string | undefined, text: string, document: RichDocument, attachments: Attachment[], broadcastConfirmed?: boolean, alsoSendToChannel?: boolean) {
    const disabled = threadId ? replyDisabledReason || (alsoSendToChannel && postDisabledReason) : postDisabledReason;
    if (draftUnavailable || checkingPermissions || disabled || channel.archived_at) throw new Error(disabled || 'Posting unavailable');
    const version = accessVersion.current;
    const key = threadId ? `thread:${channel.id}:${threadId}` : uploadKey;
    uploads.attempt(key);
    if (encrypted) {
      if(threadId)throw new ComposerSendError('Encrypted thread replies are unavailable.');
      const id=crypto.randomUUID();
      try{
        const payload=await encryption.encrypt(document,id,fileManifest(attachments));
        if(version!==accessVersion.current)throw Error('Conversation changed.');
        await outbox.enqueue({channelId:channel.id,text:encryptedMessageLabel,encrypted:payload},id);
      }catch(e){throw new ComposerSendError(e instanceof Error?e.message:'Could not encrypt message.');}
    } else {
      await outbox.enqueue({ channelId: channel.id, threadId, text, document, attachments, broadcastConfirmed, alsoSendToChannel });
    }
    uploads.sent(key, document, attachments);
    if (version !== accessVersion.current) return;
    if (!threadId) {
      setSendVersion(value => value + 1);
      if (history.page?.has_newer || history.loading) void history.load('latest');
    }
  }
  function outgoing(loaded: ChatMessage[], threadId?: string) {
    return <OutgoingMessages outbox={outbox} profile={profile} channel={channel.id} thread={threadId} history={loaded}
      retryDisabled={!ready || !!channel.archived_at || checkingPermissions || !!(threadId ? replyDisabledReason : postDisabledReason)}
      onRetry={deliver} onDelete={discardOutgoing}/>;
  }
  function applyDeletions(messages: ChatMessage[]) {
    const ids = new Set(messages.map(message => message.id));
    filesDeleted.current?.(ids);
    setDeleteId(id => id && ids.has(id) ? undefined : id);
    setEditing(current => current && ids.has(current.id) ? undefined : current);
    setSourceId(id => id && ids.has(id) ? null : id);
    setSearchMatch(match => match && ids.has(match.id) ? undefined : match);
    setMemoryMessage(message => message && ids.has(message.id) ? undefined : message);
    setSelection(selected => {
      if (!selected?.some(id => ids.has(id))) return selected;
      const remaining = selected.filter(id => !ids.has(id));
      return remaining.length ? remaining : undefined;
    });
  }
  function receiveDeletion(updated: ChatMessage) {
    history.receive([updated], stickToBottom.current);
    threadLive.current?.([updated]);
    applyDeletions([updated]);
    setAttachmentRevision(updated.reaction_sequence ?? String(updated.deleted_at));
  }
  async function deleteMessage(id: string) {
    const version = accessVersion.current;
    const updated = await request<ChatMessage>(`/channels/${channel.id}/messages/${id}`, undefined, undefined, 'DELETE');
    if (version === accessVersion.current) {
      receiveDeletion(updated);
      toast.success('Message deleted');
    }
  }
  async function saveEdit(original: ChatMessage, document: RichDocument, confirmed?: boolean) {
    const version = accessVersion.current;
    try {
      const updated = await request<ChatMessage>(`/channels/${channel.id}/messages/${original.id}`, {
        document, revision: original.reaction_sequence ?? '0', broadcast_confirmed: confirmed,
      }, undefined, 'PATCH', undefined, profile.id);
      if (version !== accessVersion.current) return;
      history.receive([updated], stickToBottom.current);
      threadLive.current?.([updated]);
      setEditing(current => current === original ? undefined : current);
    } catch (error) {
      if (error instanceof Error && error.message === 'broadcast_confirmation_required') throw error;
      throw new ComposerSendError(error instanceof Error && error.message === 'message_changed'
        ? 'This message changed. Reopen the editor to edit the latest version.'
        : 'Could not save your edit. Your draft is still here.');
    }
  }
  async function discardOutgoing(entry: OutboxEntry) {
    const version = accessVersion.current;
    try {
      const updated = await outbox.discard(entry.id);
      if (updated && version === accessVersion.current) receiveDeletion(updated);
    } catch (reason) {
      if (version === accessVersion.current) setError(errorText(reason));
    }
  }
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
      if (reason instanceof Error && reason.message === 'not_found') {
        setError('This message is unavailable.');
        checkSourceAccess();
      } else if (reason instanceof Error && ['unauthorized', 'forbidden'].includes(reason.message)) revokeAccess.current(reason);
      else setError(errorText(reason));
    }
  }
  function message(m: ChatMessage, inThread = false, arriving = false, previous?: Pick<ChatMessage, 'author' | 'created_at'>, local = false, streaming = false) {
    local = local || streaming;
    const replies = conversations.get(m.thread_id) ?? [];
    const draftKey = `thread:${channel.id}:${m.thread_id}`;
    const hasReplyDraft = !inThread && !m.channel_broadcast_sequence && m.thread_id !== thread &&
      (!!drafts[draftKey]?.ops.some(op => op.insert.trim()) || !!uploads.drafts[draftKey]?.length);
    const canEdit = !channel.archived_at && !encrypted && !encryptionUnchecked && m.author.kind === 'human' && m.author.id === profile.id
      && (!m.channel_broadcast_sequence || !postDisabledReason)
      && (direct || permissions.snapshot?.capabilities[m.thread_root_id && m.thread_root_id !== m.id ? 'reply' : 'post']);

    const saved = inThread ? m.viewer_saved : bookmarks?.has(m.id);
    async function toggleSaved() {
      await request(`/workspaces/${channel.workspace_id}/hub/saved/${m.id}`,{channel_id:channel.id,active:!saved},undefined,'POST',undefined,profile.id);
      await invalidateUpdates('actor',profile.id);
    }
    const canBroadcast = inThread && canEdit && !checkingPermissions && !postDisabledReason && !replyDisabledReason &&
      !!m.thread_root_id && m.thread_root_id !== m.id && !m.agent_session_id && !m.channel_broadcast_sequence;
    async function broadcastReply() {
      const version = accessVersion.current;
      const updated = await request<ChatMessage>(`/channels/${channel.id}/messages/${m.id}/broadcast`, {}, undefined, 'PUT', undefined, profile.id);
      if (version === accessVersion.current) { history.receive([updated], stickToBottom.current); threadLive.current?.([updated]); }
    }

    return <div id={`${inThread ? 'thread' : 'chat'}-message-${m.id}`} tabIndex={-1} className={`chat-message-anchor${searchMatch?.id === m.id ? ' channel-search-match' : ''}${selection ? ' sidekick-selectable' : ''}`}
      onClick={event => {
        if (local || m.encrypted || m.deleted_at || selection || !event.metaKey || (event.target as Element).closest('a,button,input,textarea,select,summary,[role=button],[contenteditable=true]')) return;
        event.preventDefault();
        setSelection([m.id]);
      }}>
      {selection && !local && !m.encrypted && !m.deleted_at && <button type="button" className="sidekick-message-select"
        aria-label={`Select message from ${m.author.name}: ${m.text.slice(0,60)}`}
        aria-pressed={selection.includes(m.id)}
        disabled={selection.length >= 50 && !selection.includes(m.id)}
        onClick={() => setSelection(current => !current ? current : current.includes(m.id) ? current.filter(id => id !== m.id) : current.length < 50 ? [...current, m.id] : current)}
      />}
      <div inert={!!selection}>{saved && !m.deleted_at && <small className="saved-marker"><BookmarkSimple size={12} weight="fill" aria-hidden="true"/>Saved for later · <a href={workspacePath(channel.workspace_id)+'/saved'} target={window.self!==window.top?'_top':undefined}>View Saved</a></small>}{m.channel_broadcast_sequence && <div className="thread-broadcast-context">{inThread
        ? `Also sent to ${direct ? 'this conversation' : '#'+channel.name}`
        : <button type="button" onClick={() => openThread(m.thread_id)}>Replied to a thread</button>}</div>}<ConversationMessage streaming={streaming} message={m} previous={previous} viewerId={profile.id} arrival={arriving} onReact={local || channel.archived_at ? undefined : emoji => { void react(m, emoji); }} body={m.encrypted?<EncryptedBody message={m} control={encryption} viewer={profile.id}/>:undefined}
        actions={local ? undefined : m.encrypted ? {delete:m.author.id===profile.id&&!m.deleted_at?()=>setDeleteId(m.id):undefined} : { broadcastReply: canBroadcast ? broadcastReply : undefined, edit: canEdit ? () => setEditing(m) : undefined, pin: !direct && !channel.archived_at && !m.agent_session_id ? () => pins.change(m.id, true) : undefined, delete: m.author.kind === 'human' && m.author.id === profile.id ? () => setDeleteId(m.id) : undefined, selectMessage:()=>setSelection(current=>[...new Set([...(current??[]),m.id])].slice(0,50)), discussWithAgent:()=>discuss({channel_id:channel.id,message_ids:[m.id]}), ...(!m.agent_session_id && saved!==undefined ? saved ? {unsave:toggleSaved} : {save:toggleSaved} : {}), copyMessage: () => navigator.clipboard.writeText(m.text), ...(!direct && !threadOnly ? { saveMemory: () => showMemory({ id: m.id, text: m.text }) } : {}) }} onReply={encrypted || local || inThread ? undefined : () => openThread(m.thread_id)} threadOpen={thread === m.thread_id} hasReplyDraft={hasReplyDraft} replyCount={!inThread && !m.channel_broadcast_sequence ? m.reply_summary?.count ?? m.reply_count ?? (replies[0]?.id === m.id ? replies.length - 1 : 0) : 0} onMentionClick={setSelectedMention} footer={<SessionReports message={m} inThread={inThread} reports={reports?.get(m.thread_id)} onOpen={openSessions}/>}/></div></div>;
  }
  function closeThread() {
    if (threadOnly) threadOnly.close();
    else { setSourceId(null); panels.close(); }
  }
  const roomPath = conversationPath(channel.id, requestedThread ?? thread, sourceId ?? undefined);
  usePublishedPath(threadOnly || sidekick ? undefined : sessionOpen && sessionView?.selected ? sessionPath(sessionView.selected)
    : roomPath);
  const backToAnswer = sourceId && roomPath === window.location.pathname && window.history.state?.spaceAnswerPath
    ? () => window.history.back() : undefined;
  const showDirectIntro = !!direct && ready && historyLoaded && history.page?.has_older === false;
  const loadingMessages = direct ? <ConversationLoadingStatus label="Loading messages" /> : <>
    <p className="sp-sr-only" role="status" aria-label="Loading messages">Loading messages…</p>
    <ConversationSkeleton />
  </>;
  const introduction = direct ? <ConversationIntroduction title={ready ? channel.name : status === 'Disconnected' ? 'This conversation is unavailable' : `Opening ${channel.name}`} icon={<Avatar name={channel.name} initials={channel.name.slice(0, 2).toUpperCase()} image={(direct.participants.find(person => person.id !== profile.id) ?? direct.participants[0])?.image} size="lg" tone="blue" />}>{ready ? direct.participants.length === 1 ? 'Your space for notes, links, and files.' : `This is the beginning of your conversation with ${channel.name}.` : status === 'Disconnected' ? 'Your access may have changed. Select another conversation to continue.' : 'Getting your conversation ready…'}</ConversationIntroduction> : <div className="chat-channel-welcome"><div className="chat-empty-icon"><Hash size={38}/></div><h2>{ready ? `This is the beginning of #${channel.name}` : status === 'Disconnected' ? 'This conversation is unavailable' : `Opening #${channel.name}`}</h2><p>{ready ? 'A shared space for your team’s ideas, questions, and progress. Send the first message.' : status === 'Disconnected' ? 'Your access may have changed. Select another conversation to continue.' : 'Getting your conversation ready…'}</p></div>;
  function navigation(openNavigator?: () => void) {
    const order = !direct && openNavigator ? tabs.order.filter(tabs.visible) : [];
    const openMemory = () => showMemory();
    return <ConversationNavigation order={order} view={!direct && memoryOpen ? 'memory' : pins.open ? 'pins' : !direct && filesOpen ? 'files' : 'messages'}
      onReorder={order.length > 1 && !channel.archived_at && !tabs.moving ? tabs.move : undefined}
      onChange={view => {
        if (view === 'memory') { openMemory(); return; }
        if (view === 'navigator') { openNavigator?.(); return; }
        if (!leaveMemory()) return;
        if (view === 'messages') { pins.close(); if (filesOpen) panels.close(); return; }
        setChannelSearchRequest(0); setSearchMatch(undefined);
        if (view === 'files') { pins.close(); panels.openFiles(); }
        else { panels.close(); pins.show(); }
      }}>
      {direct ? <button ref={filesButton} className="chat-files-tab" aria-expanded={filesOpen} disabled={!historyLoaded || status === 'Disconnected'} onClick={toggleFiles}><Paperclip size={15}/> Files</button>
        : openNavigator && <ChannelTabMenu onCustomize={() => showDetails('tabs')} onMemory={openMemory} onNavigator={openNavigator}/>}
      {channel.archived_at && <span className="chat-channel-privacy"><Archive size={14}/> Archived</span>}
    </ConversationNavigation>;
  }
  return <div onKeyDown={event=>{
    if (event.key==='Escape' && thread && !event.defaultPrevented && (event.target as HTMLElement).closest('.chat-thread') && !document.querySelector('dialog[open], [data-sp-popover-panel]:not([inert])')) {
      event.preventDefault(); closeThread();
    }
  }} className={`chat-conversation ${threadOnly ? 'chat-conversation--thread-only' : ''} ${thread ? 'chat-conversation--thread' : ''} ${direct && filesOpen ? 'chat-conversation--files' : ''}`}>{!threadOnly && <ConversationMain className={`chat-channel${direct ? ' chat-channel--direct' : ''}`} id="chat-messages" tabIndex={-1} aria-hidden={compact && (thread || sessionOpen || sidekick) ? true : undefined} inert={compact && !!(thread || sessionOpen || sidekick)}><FrameHeader primary><ConversationHeading title={channel.name} label={direct ? `Conversation details for ${channel.name}` : `Channel details for #${channel.name}`} onClick={() => { const person = direct && (direct.participants.find(person => person.id !== profile.id) ?? direct.participants[0]); if (person && profiles) profiles.open({kind:'user',id:person.id}); else showDetails(); }} leading={<>{(backToAnswer || openConversationList) && <IconButton className="chat-conversation-back" label={backToAnswer ? "Back to agent answer" : "Back to conversations"} onClick={backToAnswer ?? openConversationList ?? undefined}><CaretLeft size={20} weight="bold"/></IconButton>}<ConversationSectionMenu channel={channel} viewer={profile.id}/></>} icon={direct ? <Avatar name={channel.name} initials={channel.name.slice(0, 2).toUpperCase()} image={(direct.participants.find(person => person.id !== profile.id) ?? direct.participants[0])?.image} /> : channel.private ? <Lock size={20} weight="bold" /> : <Hash size={22} weight="bold" />} />{channel.topic && <button className="chat-channel-topic" title={channel.topic} onClick={() => showDetails()}>{channel.topic}</button>}<div className="chat-header-actions">{direct && !selfDirect && <CallButtons channel={channel.id}/>} {!selfDirect && <HuddleButton direct={!!direct} channel={channel.id} name={channel.name} disabled={!!channel.archived_at}/>}{!direct && <button className="chat-channel-member-button" aria-label="View channel members" onClick={() => showDetails('members')}><Users size={18} /> Members</button>}<IconButton ref={searchButton} label={`Search in ${channel.name}`} onClick={() => { if (!leaveMemory()) return; if (filesOpen || sessionOpen) panels.close(); pins.close(); setChannelSearchRequest(request => request + 1); }}><MagnifyingGlass size={20} /></IconButton>{direct && <Menu label="More conversation actions" floating trigger={<DotsThree size={22} weight="bold" />} items={[{ label: 'Conversation details', onSelect: () => showDetails() }, ...(profiles && direct.participants[0] ? [{label:'View full profile',onSelect:() => profiles.open({kind:'user',id:(direct.participants.find(person=>person.id!==profile.id)??direct.participants[0]!).id})}] : []), { label: 'Browse files', onSelect: () => { if (!filesOpen) toggleFiles(); } }, ...(onCloseDirect ? [{ label: 'Close direct message', separatorBefore: true, onSelect: onCloseDirect }] : [])]} />}{direct && onCloseDirect && <IconButton className="chat-close-direct" label="Close direct message" onClick={onCloseDirect}><X size={20} /></IconButton>}</div></FrameHeader>
    {direct || status === 'Disconnected' ? navigation() :
      <NavigatorSettings channel={channel.id} onCandidates={setNavCandidates} renderTrigger={navigation}/>}
    {tabs.moveError && <p className="chat-error" role="alert">{tabs.moveError}</p>}
    {!direct && filesOpen && showFilesTab && <ChannelResources key={channel.id} channel={channel.id} name={channel.name} showLinksFirst={!!tabs.state?.has_links && !tabs.state.has_files}
      revision={fileRevision} deletions={filesDeleted} onClose={closeFiles} onMessage={fileMessage} onAccessLost={() => revokeAccess.current(new Error('not_found'))}/>}
    {error && <p className="chat-error" role="alert">{error}{!historyLoaded && status !== 'Disconnected' && <Button size="sm" disabled={!!history.loading} onClick={() => { setError(''); history.clear(); setHistoryAttempt(value => value + 1); }}>Retry loading messages</Button>}</p>}
    {readError && <p role="status">{readError}</p>}
    {pins.open && <ChannelPins pins={pins} archived={!!channel.archived_at} onMessage={id => { pins.close(); fileMessage(id); }}/>}
    {!direct && memoryOpen && status !== 'Disconnected' && <ChannelMemory asTab channel={channel.id} name={channel.name} message={memoryMessage} onDirtyChange={trackMemoryDirty}
      onAccessLost={() => { memoryDirty.current = false; setMemoryOpen(false); setMemoryMessage(undefined); }}
      onOpenThread={id => openThread(id)} onOpenSession={(thread, session) => openSessions(thread, session)} />}
    <div className="channel-message-view" hidden={pins.open || (!direct && (filesOpen || memoryOpen))}>
    {selectionBar}
    {searchMatch && (searchMatch.thread || !messages.some(message => message.id === searchMatch.id)) && <SourceMessage key={searchMatch.id}
      channel={channel.id} name={channel.name} direct={!!direct} messageId={searchMatch.id}
      onClose={() => setSearchMatch(undefined)} onUnavailable={checkSourceAccess}
      onOpenThread={searchMatch.thread ? () => { closeChannelSearch(); openThread(searchMatch.thread!); } : undefined}/>}
    <MessageTimeline target={linkedReply ? undefined : target} hidden={pins.open || (!direct && (filesOpen || memoryOpen))} header={showDirectIntro ? introduction : undefined} onAtEndChange={setAtEnd} label={`Messages in ${channel.name}`} items={rows} page={history.page} loading={history.loading} latestVersion={history.latestVersion + sendVersion} load={history.load} pinned={stickToBottom} handle={timeline} busy={!historyLoaded && status !== 'Disconnected'} render={(row, index) => {
      const previous = rows[index - 1];
      const unread = 'message' in row && row.message.id === firstUnread;
      return <><ConversationDateDivider date={row.created_at} previous={previous?.created_at}/>
        {'message' in row && row.message.encrypted && (previous && 'message' in previous && !previous.message.encrypted && !previous.message.deleted_at || !previous && history.page?.has_older===false) && <div className="dm-encryption-boundary">End-to-end encrypted messages</div>}
        {unread && <div className="chat-unread-divider" role="separator" aria-label="New messages"><span>New messages</span></div>}
        {'entry' in row && row.entry.status !== 'sending'
          ? <OutgoingMessage entry={row.entry} grouped={continuesMessageGroup(row, previous)} profile={profile} retryDisabled={!ready || !!channel.archived_at || checkingPermissions || !!postDisabledReason} onRetry={deliver} onDelete={discardOutgoing}/>
          : message('message' in row ? row.message : {
            id: row.entry.id, channel_id: channel.id, thread_id: row.entry.id, task_id: null,
            client_message_id: row.entry.id, author: row.author, created_at: row.created_at,
            encrypted:row.entry.encrypted,text: row.entry.text, document: row.entry.document, attachments: row.entry.attachments,
          }, false, arrivals.has(row.id), unread ? undefined : previous, 'entry' in row, 'message' in row && row.streaming)}
      </>;
    }}>
      {!historyLoaded && status !== 'Disconnected' ? loadingMessages : !rows.length && !showDirectIntro && introduction}
    </MessageTimeline>{!direct&&!thread&&!sessionOpen&&!channel.archived_at&&status!=='Disconnected'&&<NavigatorSuggestions channel={channel.id} onThread={openThread} />}{channel.archived_at ? <div className="chat-channel-archived"><strong>This channel is archived</strong>Its messages are available to read.<br /><Button size="sm" onClick={() => showDetails('settings')}>View channel settings</Button></div> : status !== 'Disconnected' && <ConversationComposer primary onEditReady={editDraftKey === uploadKey && !draftUnavailable && !channel.archived_at ? onMentionOpened : undefined} inactive={draftUnavailable} conversationKey={draftRevision ? `${uploadKey}:${draftRevision}` : uploadKey}
      controls={{
        audioClipsEnabled: !direct,
        videoClipsEnabled: !direct,
        findMentions: encrypted || encryptionUnchecked ? undefined : findMentions,
        mentions: encrypted || encryptionUnchecked ? [] : agentTags,
        attachmentsEnabled: uploads.enabled && !encryption.loading && (!encrypted || encryption.verified && encryption.enrolled),
        onSchedule: canSchedule(undefined) ? async (text, document, files, at) => {
          await scheduleMessage(channel.id, undefined, text, document, files, at);
          channelTyping.stop();
        } : undefined,
      }}
      workspace={encrypted ? undefined : channel.workspace_id}
      sendDisabled={checkingPermissions || !historyLoaded || draftUnavailable}
      sendDisabledReason={encryptionUnchecked ? (encryption.failure || undefined) : draftLocked ? 'Link this device in conversation details to open your encrypted draft.' : postDisabledReason}
      onBlurCapture={channelTyping.blur}
      typingIndicator={<TypingIndicator channel={channel.id} viewerId={profile.id} enabled={ready}/>}
      attachments={uploads.drafts[uploadKey] ?? []}
      onAttachmentsChange={files => { if (!files.length || !encryptionUnchecked) uploads.change(uploadKey, channel.id, files, transfer); }}
      onRetryAttachment={id => { if(!encryptionUnchecked) uploads.retry(uploadKey, channel.id, id, transfer); }}
      channel={channel.name}
      placeholder={encrypted?'Write an encrypted message…':selfDirect ? 'Jot something down' : direct ? `Message ${channel.name}` : undefined}
      draftValue={draftUnavailable ? null : drafts[uploadKey] ?? null}
      acknowledgedDocument={draftUnavailable ? undefined : uploads.acknowledged[uploadKey]}
      onDraftChange={document => {
        if (draftUnavailable) return;
        onDraftChange(uploadKey, document);
        channelTyping.change(document);
      }}
      onSend={(text, document, files, options) => { channelTyping.stop(); return submit(undefined, text, document, files, options?.broadcast_confirmed); }} />}</div></ConversationMain>}
    {threadOnly && error && <p role="alert">{error}</p>}
    {!threadOnly && !compact && status !== 'Disconnected' && (thread || sessionOpen || sidekick || (direct && filesOpen)) && <ConversationPanelDivider files={filesOpen} />}
    {status !== 'Disconnected' && <AnimatePresence>{thread && <SidePanel ref={threadPanel} key="thread" role="region" className="chat-thread" aria-label="Thread"><ConversationHeader title="Thread" onBack={backToAnswer} closeBackLabel={threadOnly && !threadOnly.detached ? "Back to Threads" : undefined} backLabel="Back to agent answer" actions={<><ThreadNotificationToggle key={thread} thread={thread}/>{!threadOnly?.detached && conversationPath(channel.id,thread) && <a className="thread-popout" aria-label="Open thread in a new window" title="Open thread in a new window" target="_blank" rel="noopener noreferrer" href={conversationPath(channel.id,thread)+'?threadWindow=1'}><ArrowSquareOut size={18}/></a>}</>} channel={direct ? undefined : channel.name} status={direct ? channel.name : undefined} onClose={closeThread} />
      {selectionBar}
      <ThreadHistory channelHistoryLoaded={historyLoaded} workspace={channel.workspace_id} target={linkedReply && target?.thread_id === thread ? target : undefined} renderOutgoing={loaded => outgoing(loaded, thread)} key={thread} thread={thread} channel={channel.id} live={threadLive} renderMessage={(m, arriving) => message(m, true, arriving)} activity={[...activity.values()].filter(event => event.thread_id === thread && !event.payload.data.session_managed)} profile={profile} onOpenWorkspace={openAgentSession} onAccessLost={reason => revokeAccess.current(reason)} footer={<>
      {!direct && <NavigatorSuggestions channel={channel.id} thread={thread} />}
      {socket && !channel.archived_at && !encrypted && !encryption.loading && <ThreadComposer onEditReady={editDraftKey === `thread:${channel.id}:${thread}` ? onMentionOpened : undefined} broadcastDestination={!checkingPermissions && !postDisabledReason && !replyDisabledReason ? direct ? 'this conversation' : `#${channel.name}` : undefined} workspace={channel.workspace_id} sendDisabled={checkingPermissions} sendDisabledReason={replyDisabledReason} suggestionRevision={ready ? replyRevision : undefined} viewerId={profile.id} key={`reply:${thread}`} onSend={(text, document, files, options, broadcast) => submit(thread, text, document, files, options?.broadcast_confirmed, broadcast)} onSchedule={canSchedule(thread) ? (text, document, files, at, broadcast) => scheduleMessage(channel.id, thread, text, document, files, at, broadcast).then(() => {}) : undefined} mentions={agentTags} uploads={uploads} socket={socket} channel={channel.id} thread={thread} draft={drafts[`thread:${channel.id}:${thread}`]} onDraftChange={document => onDraftChange(`thread:${channel.id}:${thread}`, document)} />}
      </>} />
    </SidePanel>}</AnimatePresence>}
    {status !== 'Disconnected' && sidekick && <SidePanel ref={sidekickPanel} role="region" className="chat-thread chat-agent-sessions" aria-label="My sidekick"><Sidekick drafts={drafts} onDraftChange={onDraftChange} attempt={uploads.attempt} acknowledged={uploads.acknowledged} uploads={uploads} onAccepted={uploads.sent} key={channel.workspace_id} workspace={channel.workspace_id} viewerId={profile.id} source={sidekick.source} onClose={threadOnly ? () => openThread(requestedThread!) : panels.close}/></SidePanel>}
    {status !== 'Disconnected' && sessionView && <SidePanel ref={sessionPanel} key={`sessions:${sessionView.thread}`} role="region" hidden={!sessionOpen} className="chat-thread chat-agent-sessions" aria-label="Agent session">
      <AgentSessions acknowledged={uploads.acknowledged} uploads={uploads} onAccepted={uploads.sent} drafts={drafts} onDraftChange={onDraftChange} attempt={uploads.attempt} thread={sessionView.thread} channel={channel.id} viewerId={profile.id} initialSessionId={sessionView.selected} initialArtifact={sessionView.artifact} artifactRequest={sessionView.artifactRequest} archived={!!channel.archived_at} channelName={channel.name} onBack={() => openThread(sessionView.thread)} onClose={threadOnly ? () => openThread(requestedThread!) : panels.close} onAccessLost={() => revokeAccess.current(new Error('not_found'))} />
    </SidePanel>}
    {status !== 'Disconnected' && <AnimatePresence>{direct && filesOpen && <ChannelFiles direct={!!direct} key={channel.id} channel={channel.id} name={channel.name} revision={fileRevision} deletions={filesDeleted} onClose={closeFiles} onMessage={fileMessage} onAccessLost={() => revokeAccess.current(new Error('not_found'))} />}</AnimatePresence>}
    {status !== 'Disconnected' && encrypted && channelSearchOpen && <EncryptedSearch key={channel.id} channel={channel.id} actor={profile.id} control={encryption} onClose={closeChannelSearch} onOpen={id=>{
      closeChannelSearch();if(messages.some(m=>m.id===id))reveal(id);else setSourceId(id);
    }}/>}
    {status !== 'Disconnected' && !encrypted && !encryptionUnchecked && <MessageSearch workspace={channel.workspace_id} channel={{id:channel.id,name:channel.name}} open={channelSearchOpen} editRequest={channelSearchRequest} onChannelSubmit={() => { panels.close(); setSearchMatch(undefined); }} onClose={closeChannelSearch} onSelect={result => {
      setSearchMatch({ id: result.id, thread: result.is_reply ? result.thread_id : undefined });
      if (!result.is_reply && messages.some(message => message.id === result.id)) reveal(result.id);
    }} />}
    {editing && editing.channel_id === channel.id && status !== 'Disconnected' && <Dialog open title="Edit message" onClose={() => setEditing(undefined)}>
      <RichComposer key={editing.id} channel="edit" scope={editing.thread_root_id && editing.thread_root_id !== editing.id ? 'thread' : 'channel'}
        autoFocus defaultValue={editing.document ?? {ops:[{insert:editing.text}]}} findMentions={findMentions}
        attachmentsEnabled={false} showUnavailableActions={false} showKeyboardHint={false} submitLabel="Save changes"
        submitIcon={<Check size={18}/>} onSend={(_text, document, _files, options) => saveEdit(editing, document, options?.broadcast_confirmed)}/>
      <Button variant="ghost" onClick={() => setEditing(undefined)}>Cancel</Button>
    </Dialog>}
    {deleteId && status !== 'Disconnected' && <DeleteMessageDialog key={deleteId} onClose={() => setDeleteId(undefined)} onConfirm={() => deleteMessage(deleteId)} />}
    {direct ? <Dialog open={detailsOpen} title={channel.name} onClose={() => setDetailsOpen(false)}><p>Only the participants in this conversation can read and send messages.</p>{detailsOpen&&<EncryptionSettings dm={direct} actor={profile.id} control={encryption}/>}<ul className="dm-details-members">{direct.participants?.map(person => <li key={person.id}><button type="button" className="space-profile-trigger" aria-label={`View ${person.name}’s profile`} onClick={() => {setDetailsOpen(false); profiles?.open({kind:'user',id:person.id});}}><Avatar name={person.name} initials={person.name.slice(0, 2).toUpperCase()} size="sm" /><strong>{person.name}{person.id === profile.id ? ' (you)' : ''}</strong></button></li>)}</ul><Button onClick={onCloseDirect}>Close direct message</Button></Dialog> : <ChannelDetails permissions={permissions.snapshot} permissionsPending={!permissions.snapshot} channel={channel} viewer={profile.id} open={detailsOpen} initialTab={detailsTab} onClose={() => setDetailsOpen(false)} onChange={onChannelChange} onLeft={onLeft} />}
    {selectedMention && status !== 'Disconnected' && <MentionDetails channel={channel.id} mention={selectedMention} onClose={() => setSelectedMention(undefined)} />}
  </div>;
}
function DeleteMessageDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    setBusy(true);
    setError('');
    try { await onConfirm(); }
    catch (reason) {
      setError(reason instanceof Error && reason.message === 'asset_processing_busy'
        ? 'An attachment is still processing. Try again in a moment.'
        : `Could not delete this message. ${errorText(reason)}`);
    }
    finally { setBusy(false); }
  }
  return <Dialog open title="Delete message?" description="This permanently removes the message from the conversation." onClose={onClose} onBeforeClose={() => !busy}>
    {error && <p className="chat-error" role="alert">{error}</p>}
    <div className="chat-form-actions"><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} onClick={() => void confirm()}>Delete message</Button></div>
  </Dialog>;
}
function recentTasks(events: ChatEvent[]): ChatEvent[] {
  const tasks = new Map<string, ChatEvent & { type: 'task.event' }>();
  for (const event of events) if (event.type === 'task.event') {
    const previous = tasks.get(event.payload.task_id);
    tasks.set(event.payload.task_id, { ...event, payload: { ...event.payload, data: { ...previous?.payload.data, ...event.payload.data } } });
  }
  return [...tasks.values()].slice(-100);
}
