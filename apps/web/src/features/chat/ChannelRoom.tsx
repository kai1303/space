import { conversationPath, parseConversationPath, sessionPath } from '@space/contracts';
import { usePublishedPath } from '../../shared/ui/conversation-location.js';
import { useMemberProfile } from '../profile/MemberProfile.js';
import { HuddleButton } from '../huddles/Huddles.js';
import { Sidekick } from '../agents/Sidekick.js';
import type { SidekickSource } from '@space/contracts';
import { CallButtons } from '../calling/Calling.js';
import type { Snapshot } from '../../shared/ui/view-state.js';
import type { ConversationView } from './view-state.js';
import { useStarredChannels } from '../channels/useStarredChannels.js';
import { ThreadNotificationToggle } from '../notifications/Notifications.js';
import { ConversationHeader, ConversationComposer, ConversationMessage, continuesMessageGroup, ConversationNavigation, ConversationIntroduction } from './ThreadConversation.js';
import { AgentSessions } from '../agents/AgentSessions.js';
import { TypingIndicator, useTypingPublisher } from './typing.js';
import { acquireRealtime } from '../../shared/realtime/socket-session.js';
import { MentionDetails, useMentionSearch } from "../mentions/Mentions.js";
import { NavigatorSettings, NavigatorSuggestions, agentMention } from '../agents/Navigator.js';
import { MessageTimeline, type TimelineHandle } from './MessageTimeline.js';
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
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ChannelUnread, MentionReference, NavigatorCandidate, ChatEvent, ChatHistory, ChatMessage, DirectMessageSummary } from '@space/contracts';
import { Avatar, Button, Dialog, IconButton, Menu, SidePanel, toast } from '@space/ui/primitives';
import { ConversationHeading, ConversationDateDivider, useMessageArrivals } from '@space/ui/conversation';
import { MessageSearch } from '../search/MessageSearch.js';
import { motionTransition } from '@space/ui/motion';
import { type RichDocument } from '@space/ui/rich-text';
import { Archive, CaretLeft, ChatCircle, DotsThree, Hash, Lock, MagnifyingGlass, Paperclip, Robot, Users, X, Star } from '@phosphor-icons/react';
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

export function ChannelRoom({ viewState, requestedThread, onCloseDirect, readState, uploads, profile, channel, onChannelChange, onLeft, drafts, onDraftChange, onAccessLost, searchOpen, composeRequest, mentionTarget, onMentionOpened }: { viewState?:Snapshot<ConversationView>; requestedThread?: string; onCloseDirect?: () => void; readState?: ChannelUnread; uploads: UploadDrafts; profile: Profile; channel: Channel; onChannelChange: (channel: Channel) => void; onLeft: () => void; drafts: Record<string, RichDocument>; onDraftChange: (key: string, document: RichDocument) => void; onAccessLost: () => void; searchOpen: boolean; onSearchClose: () => void; composeRequest: number; mentionTarget?: string; onMentionOpened: () => void }) {
  const profiles = useMemberProfile();
  const [selection,setSelection]=useState<string[]|undefined>();
  const panels = useConversationPanels(viewState, requestedThread, mentionTarget);
  const {sidekick, thread, sessionView, sessionOpen, filesOpen, threadPanel, sessionPanel, sidekickPanel, openThread, openSessions} = panels;
  useEffect(()=>setSelection(undefined),[channel.id]);
  function discuss(source:SidekickSource){panels.openSidekick(source);setSelection(undefined);}
  const selectionBar=selection&&<div className="sidekick-selection" role="region" aria-label="Selected messages"><strong>{selection.length} selected</strong><span className="sidekick-selection-hint">Click messages to select</span><Button size="sm" disabled={!selection.length} onClick={()=>discuss({channel_id:channel.id,message_ids:selection})}>Discuss with agent</Button><Button size="sm" variant="ghost" onClick={()=>setSelection(undefined)}>Cancel selection</Button></div>;
  const direct = channel.kind === 'direct' ? channel as DirectMessageSummary : undefined;
  const permissions = useChannelPermissions(direct ? undefined : channel.id, channel.workspace_id);
  const checkingPermissions = !direct && !permissions.snapshot && !permissions.error;
  const permissionUnavailable = permissions.error || undefined;
  const outbox = useMemo(() => getMessageOutbox(profile.id, channel.workspace_id), [profile.id, channel.workspace_id]);
  const postDisabledReason = direct ? undefined : !permissions.snapshot ? permissionUnavailable : permissions.snapshot.capabilities.post ? undefined : 'You can read this channel, but posting is restricted.';
  const replyDisabledReason = direct ? undefined : !permissions.snapshot ? permissionUnavailable : permissions.snapshot.capabilities.reply ? undefined : 'You can read this thread, but replies are restricted.';
  const selfDirect = direct?.participants.length === 1 && direct.participants[0]?.id === profile.id;
  const starred = useStarredChannels(channel.workspace_id, channel.id, profile.id);
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
  useEffect(() => { if (requestedThread) { openThread(requestedThread); onMentionOpened(); } }, [requestedThread]);
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
    if (location.pathname.startsWith('/c/')) {
      const link = parseConversationPath(location.pathname);
      if (link.channel === channel.id && link.message) return link.message;
    }
    return params.get('channel') === channel.id ? params.get('message') : null;
  });
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
  const filesDeleted = useRef<((ids: ReadonlySet<string>) => void) | null>(null);
  const activeThread = useRef(thread);
  activeThread.current = thread;
  const [replyRevision, setReplyRevision] = useState('0');
  const threadLive = useRef<((messages: ChatMessage[], sent?: boolean) => void) | null>(null);
  const openConversationList = useContext(ConversationListContext);
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
      terminal = true; accessVersion.current++; outbox.purgeChannel(channel.id);
      if (active) {
        accessLost.current(); setError(errorText(reason)); setReady(false); history.clear(); setEvents([]);
        panels.clear(); setChannelSearchRequest(0); setSearchMatch(undefined); setSourceId(null); setSelectedMention(undefined);
        setSelection(undefined);setMemoryOpen(false); setMemoryMessage(undefined); setStatus('Disconnected');
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
        const latestReply = batch.events.filter(event => event.type === 'message.created' && event.thread_id === activeThread.current && !event.payload.agent_session_id).at(-1);
        if (latestReply) setReplyRevision(latestReply.sequence);
        const outgoing = outbox.getSnapshot();
        history.receive(incoming, stickToBottom.current); threadLive.current?.(incoming);
        for (const saved of incoming) {
          if (saved.author.id !== profile.id || !saved.client_message_id) continue;
          const entry = outgoing.find(row => row.channelId === channel.id && row.id === saved.client_message_id);
          if (entry && (entry.status === 'sending' || entry.status === 'failed')) acceptDelivery(saved, !!entry.threadId);
        }
        outbox.reconcile(incoming);
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
      active = false; accessVersion.current++; revokeAccess.current = () => {};
      if (client.connected) void command(client, 'channel.unsubscribe', { channel_id: channel.id }).catch(() => {});
      connection.release();
    };
  }, [channel.id, channel.workspace_id, historyAttempt]);
  const [atEnd, setAtEnd] = useState(true);
  const entryRead = useRef<string | undefined>(undefined);
  if (entryRead.current === undefined && readState) entryRead.current = readState.last_read_sequence;
  const messages = history.page?.messages ?? [];
  const readError = useChannelRead(channel.id, history.page?.newer_cursor ?? '0', readState?.last_read_sequence,
    historyLoaded && ready && !history.loading && !history.page?.has_newer && atEnd && !pins.open && !searchOpen && !filesOpen && !sourceId && !detailsOpen && !memoryOpen && !selectedMention && !profiles?.selected && !(compact && sessionOpen) && !sidekick);
  const firstUnread = entryRead.current === undefined ? undefined : messages.find(message => message.author.id !== profile.id && BigInt(message.sequence ?? '0') > BigInt(entryRead.current!))?.id;
  const [sendVersion, setSendVersion] = useState(0);
  const pending = useOutgoingMessages({ outbox, profile, channel: channel.id, history: messages });
  const ownAuthor = { kind: 'human' as const, id: profile.id, name: profile.display_name };
  const rows = [
    ...messages.map(message => ({
      id: message.author.kind === 'human' && message.author.id === profile.id && message.client_message_id
        ? `outgoing:${message.client_message_id}` : `message:${message.id}`,
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
    } else history.sent(saved);
    window.dispatchEvent(new Event('space:mentions-changed'));
  }
  function deliver(entry: OutboxEntry, confirmBroadcast = false) {
    const version = accessVersion.current;
    void outbox.send(entry.id, socket, confirmBroadcast || entry.broadcastConfirmed, saved => {
      if (version !== accessVersion.current) return;
      acceptDelivery(saved, !!entry.threadId);
    });
  }
  // Scheduling follows the same posting rules as sending now; the server re-checks them at send time.
  function canSchedule(threadId: string | undefined) {
    return !checkingPermissions && !channel.archived_at && !(threadId ? replyDisabledReason : postDisabledReason);
  }
  function submit(threadId: string | undefined, text: string, document: RichDocument, attachments: Attachment[], broadcastConfirmed?: boolean) {
    const disabled = threadId ? replyDisabledReason : postDisabledReason;
    if (checkingPermissions || disabled || channel.archived_at) throw new Error(disabled || 'Posting unavailable');
    const entry = outbox.enqueue({ channelId: channel.id, threadId, text, document, attachments, broadcastConfirmed });
    if (!threadId) setSendVersion(value => value + 1);
    deliver(entry);
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
  function message(m: ChatMessage, inThread = false, arriving = false, previous?: Pick<ChatMessage, 'author' | 'created_at'>) {
    const replies = conversations.get(m.thread_id) ?? [];
    return <div key={m.id} id={`${inThread ? 'thread' : 'chat'}-message-${m.id}`} tabIndex={-1} className={`chat-message-anchor${searchMatch?.id === m.id ? ' channel-search-match' : ''}${selection ? ' sidekick-selectable' : ''}`}
      onClick={event => {
        if (m.deleted_at || selection || !event.metaKey || (event.target as Element).closest('a,button,input,textarea,select,summary,[role=button],[contenteditable=true]')) return;
        event.preventDefault();
        setSelection([m.id]);
      }}>
      {selection && !m.deleted_at && <button type="button" className="sidekick-message-select"
        aria-label={`Select message from ${m.author.name}: ${m.text.slice(0,60)}`}
        aria-pressed={selection.includes(m.id)}
        disabled={selection.length >= 50 && !selection.includes(m.id)}
        onClick={() => setSelection(current => !current ? current : current.includes(m.id) ? current.filter(id => id !== m.id) : current.length < 50 ? [...current, m.id] : current)}
      />}
      <div inert={!!selection}><ConversationMessage message={m} previous={previous} viewerId={profile.id} arrival={arriving} onReact={channel.archived_at ? undefined : emoji => { void react(m, emoji); }} actions={{ pin: !direct && !channel.archived_at && !m.agent_session_id ? () => pins.change(m.id, true) : undefined, delete: m.author.kind === 'human' && m.author.id === profile.id ? () => setDeleteId(m.id) : undefined, selectMessage:()=>setSelection(current=>[...new Set([...(current??[]),m.id])].slice(0,50)), discussWithAgent:()=>discuss({channel_id:channel.id,message_ids:[m.id]}), save: () => request(`/workspaces/${channel.workspace_id}/hub/saved/${m.id}`, { channel_id: channel.id, active: true }).then(() => {}), copyMessage: () => navigator.clipboard.writeText(m.text), ...(!direct ? { saveMemory: () => { setMemoryMessage({ id: m.id, text: m.text }); setMemoryOpen(true); } } : {}) }} onReply={inThread ? undefined : () => openThread(m.thread_id)} replyCount={!inThread ? m.reply_count ?? (replies[0]?.id === m.id ? replies.length - 1 : 0) : 0} onMentionClick={setSelectedMention} footer={!inThread && m.agent_sessions?.map(session => <button key={session.id} type="button" className="sp-thread-link chat-session-link" aria-label={`Agent session: ${session.title}`} title={session.title} onClick={() => openSessions(m.thread_id, session.id)}><Robot size={14} aria-hidden="true" />Agent session<span>{session.title}</span></button>)}/></div></div>;
  }
  const roomPath = conversationPath(channel.id, requestedThread ?? thread, sourceId ?? undefined);
  usePublishedPath(sidekick ? undefined : sessionOpen && sessionView?.selected ? sessionPath(sessionView.selected)
    : roomPath);
  const showDirectIntro = !!direct && ready && historyLoaded && history.page?.has_older === false;
  const loadingMessages = direct ? <ConversationLoadingStatus label="Loading messages" /> : <>
    <p className="sp-sr-only" role="status" aria-label="Loading messages">Loading messages…</p>
    <ConversationSkeleton />
  </>;
  const introduction = direct ? <ConversationIntroduction title={ready ? channel.name : status === 'Disconnected' ? 'This conversation is unavailable' : `Opening ${channel.name}`} icon={<Avatar name={channel.name} initials={channel.name.slice(0, 2).toUpperCase()} image={(direct.participants.find(person => person.id !== profile.id) ?? direct.participants[0])?.image} size="lg" tone="blue" />}>{ready ? direct.participants.length === 1 ? 'Your space for notes, links, and files.' : `This is the beginning of your conversation with ${channel.name}.` : status === 'Disconnected' ? 'Your access may have changed. Select another conversation to continue.' : 'Getting your conversation ready…'}</ConversationIntroduction> : <div className="chat-channel-welcome"><div className="chat-empty-icon"><Hash size={38}/></div><h2>{ready ? `This is the beginning of #${channel.name}` : status === 'Disconnected' ? 'This conversation is unavailable' : `Opening #${channel.name}`}</h2><p>{ready ? 'A shared space for your team’s ideas, questions, and progress. Send the first message.' : status === 'Disconnected' ? 'Your access may have changed. Select another conversation to continue.' : 'Getting your conversation ready…'}</p></div>;
  function navigation(openNavigator?: () => void) {
    const order = !direct && openNavigator ? tabs.order.filter(tabs.visible) : [];
    const openMemory = () => { setMemoryMessage(undefined); setMemoryOpen(true); };
    return <ConversationNavigation order={order} view={pins.open ? 'pins' : !direct && filesOpen ? 'files' : 'messages'}
      onReorder={order.length > 1 && !channel.archived_at && !tabs.moving ? tabs.move : undefined}
      onChange={view => {
        if (view === 'memory') { openMemory(); return; }
        if (view === 'navigator') { openNavigator?.(); return; }
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
  return <motion.div initial={false} animate={{ opacity: reduced || historyLoaded || status === 'Disconnected' ? 1 : .65 }} transition={motionTransition(reduced)} className={`chat-conversation ${thread ? 'chat-conversation--thread' : ''} ${direct && filesOpen ? 'chat-conversation--files' : ''}`}><main className={`chat-channel${direct ? ' chat-channel--direct' : ''}`} id="chat-messages" tabIndex={-1} aria-hidden={compact && (thread || sessionOpen || sidekick) ? true : undefined} inert={compact && !!(thread || sessionOpen || sidekick)}><header className="chat-channel-header"><ConversationHeading title={channel.name} label={direct ? `Conversation details for ${channel.name}` : `Channel details for #${channel.name}`} onClick={() => { const person = direct && (direct.participants.find(person => person.id !== profile.id) ?? direct.participants[0]); if (person && profiles) profiles.open({kind:'user',id:person.id}); else showDetails(); }} leading={<>{openConversationList && <IconButton className="chat-conversation-back" label="Back to conversations" onClick={openConversationList}><CaretLeft size={20} weight="bold"/></IconButton>}<IconButton label={starred.active ? 'Unstar conversation' : 'Star conversation'} aria-pressed={starred.active} aria-disabled={starred.busy || undefined} onClick={() => void starred.toggle(channel.id, { id: channel.id, name: channel.name, kind: channel.kind ?? 'channel', private: channel.private }).catch(reason => setError(errorText(reason)))}><Star size={19} weight={starred.active ? 'fill' : 'regular'}/></IconButton></>} icon={direct ? <Avatar name={channel.name} initials={channel.name.slice(0, 2).toUpperCase()} image={(direct.participants.find(person => person.id !== profile.id) ?? direct.participants[0])?.image} /> : channel.private ? <Lock size={20} weight="bold" /> : <Hash size={22} weight="bold" />} />{channel.topic && <button className="chat-channel-topic" title={channel.topic} onClick={() => showDetails()}>{channel.topic}</button>}<div className="chat-header-actions">{direct && !selfDirect && <CallButtons channel={channel.id}/>} {!direct && <HuddleButton channel={channel.id} name={channel.name} disabled={!!channel.archived_at}/>}{!direct && <IconButton label="Agents & apps" onClick={() => showDetails('integrations')}><Robot size={19}/></IconButton>}{!direct && <button className="chat-channel-member-button" aria-label="View channel members" onClick={() => showDetails('members')}><Users size={18} /> Members</button>}<IconButton ref={searchButton} label={`Search in ${channel.name}`} onClick={() => { if (filesOpen || sessionOpen) panels.close(); pins.close(); setChannelSearchRequest(request => request + 1); }}><MagnifyingGlass size={20} /></IconButton>{direct && <Menu label="More conversation actions" floating trigger={<DotsThree size={22} weight="bold" />} items={[{ label: 'Conversation details', onSelect: () => showDetails() }, ...(profiles && direct.participants[0] ? [{label:'View full profile',onSelect:() => profiles.open({kind:'user',id:(direct.participants.find(person=>person.id!==profile.id)??direct.participants[0]!).id})}] : []), { label: 'Browse files', onSelect: () => { if (!filesOpen) toggleFiles(); } }, ...(onCloseDirect ? [{ label: 'Close direct message', separatorBefore: true, onSelect: onCloseDirect }] : [])]} />}{direct && onCloseDirect && <IconButton label="Close direct message" onClick={onCloseDirect}><X size={20} /></IconButton>}</div></header>
    {direct || status === 'Disconnected' ? navigation() :
      <NavigatorSettings channel={channel.id} onCandidates={setNavCandidates} renderTrigger={navigation}/>}
    {tabs.moveError && <p className="chat-error" role="alert">{tabs.moveError}</p>}
    {!direct && filesOpen && showFilesTab && <ChannelResources key={channel.id} channel={channel.id} name={channel.name} showLinksFirst={!!tabs.state?.has_links && !tabs.state.has_files}
      revision={fileRevision} deletions={filesDeleted} onClose={closeFiles} onMessage={fileMessage} onAccessLost={() => revokeAccess.current(new Error('not_found'))}/>}
    {error && <p className="chat-error" role="alert">{error}{!historyLoaded && status !== 'Disconnected' && <Button size="sm" disabled={!!history.loading} onClick={() => { setError(''); history.clear(); setHistoryAttempt(value => value + 1); }}>Retry loading messages</Button>}</p>}
    {readError && <p role="status">{readError}</p>}
    {pins.open && <ChannelPins pins={pins} archived={!!channel.archived_at} onMessage={id => { pins.close(); fileMessage(id); }}/>}
    <div className="channel-message-view" hidden={pins.open || (!direct && filesOpen)}>
    {selectionBar}
    {searchMatch && (searchMatch.thread || !messages.some(message => message.id === searchMatch.id)) && <SourceMessage inline key={searchMatch.id}
      channel={channel.id} name={channel.name} direct={!!direct} messageId={searchMatch.id}
      onClose={() => setSearchMatch(undefined)} onUnavailable={checkSourceAccess}
      onOpenThread={searchMatch.thread ? () => { closeChannelSearch(); openThread(searchMatch.thread!); } : undefined}/>}
    <MessageTimeline hidden={pins.open || (!direct && filesOpen)} header={showDirectIntro ? introduction : undefined} onAtEndChange={setAtEnd} label={`Messages in ${channel.name}`} items={rows} page={history.page} loading={history.loading} latestVersion={history.latestVersion + sendVersion} load={history.load} pinned={stickToBottom} handle={timeline} busy={!historyLoaded && status !== 'Disconnected'} render={(row, index) => {
      const previous = rows[index - 1];
      const unread = 'message' in row && row.message.id === firstUnread;
      return <><ConversationDateDivider date={row.created_at} previous={previous?.created_at}/>
        {unread && <div className="chat-unread-divider" role="separator" aria-label="New messages"><span>New messages</span></div>}
        {'entry' in row
          ? <OutgoingMessage entry={row.entry} grouped={continuesMessageGroup(row, previous)} profile={profile} retryDisabled={!ready || !!channel.archived_at || checkingPermissions || !!postDisabledReason} onRetry={deliver} onDelete={discardOutgoing}/>
          : message(row.message, false, arrivals.has(row.id), unread ? undefined : previous)}
      </>;
    }}>
      {!historyLoaded && status !== 'Disconnected' ? loadingMessages : !rows.length && !showDirectIntro && introduction}
    </MessageTimeline>{!direct&&!thread&&!sessionOpen&&!channel.archived_at&&status!=='Disconnected'&&<NavigatorSuggestions channel={channel.id} onThread={openThread} />}{channel.archived_at ? <div className="chat-channel-archived"><strong>This channel is archived</strong>Its messages are available to read.<br /><Button size="sm" onClick={() => showDetails('settings')}>View channel settings</Button></div> : status !== 'Disconnected' && <ConversationComposer sendDisabled={checkingPermissions || !historyLoaded} sendDisabledReason={postDisabledReason} onBlurCapture={channelTyping.blur} typingIndicator={<TypingIndicator channel={channel.id} viewerId={profile.id} enabled={ready}/>} showUnavailableActions={!direct} findMentions={findMentions} mentions={agentTags} attachmentsEnabled={uploads.enabled} attachments={uploads.drafts[channel.id] ?? []} onAttachmentsChange={files => uploads.change(channel.id, channel.id, files)} onRetryAttachment={id => uploads.retry(channel.id, channel.id, id)} channel={channel.name} placeholder={selfDirect ? 'Jot something down' : direct ? `Message ${channel.name}` : undefined} defaultValue={drafts[channel.id]} onDraftChange={document => {onDraftChange(channel.id, document);channelTyping.change(document);}} onSend={(text, document, files, options) => { submit(undefined, text, document, files, options?.broadcast_confirmed); channelTyping.stop(); }} onSchedule={canSchedule(undefined) ? async (text, document, files, at) => { await scheduleMessage(channel.id, undefined, text, document, files, at); channelTyping.stop(); } : undefined} />}</div></main>
    {!compact && status !== 'Disconnected' && (thread || sessionOpen || sidekick || (direct && filesOpen)) && <ConversationPanelDivider files={filesOpen} />}
    {status !== 'Disconnected' && <AnimatePresence>{thread && <SidePanel ref={threadPanel} key="thread" role="region" className="chat-thread" aria-label="Thread"><ConversationHeader title="Thread" actions={<ThreadNotificationToggle key={thread} thread={thread}/>} channel={direct ? undefined : channel.name} status={direct ? channel.name : undefined} onClose={panels.close} />
      {selectionBar}
      <ThreadHistory renderOutgoing={loaded => outgoing(loaded, thread)} key={thread} thread={thread} channel={channel.id} live={threadLive} renderMessage={(m, arriving) => message(m, true, arriving)} activity={[...activity.values()].filter(event => event.thread_id === thread && !event.payload.data.session_managed)} profile={profile} onOpenWorkspace={openAgentSession} onAccessLost={reason => revokeAccess.current(reason)} footer={<>
      {!direct && <NavigatorSuggestions channel={channel.id} thread={thread} />}
      {socket && !channel.archived_at && <ThreadComposer sendDisabled={checkingPermissions} sendDisabledReason={replyDisabledReason} suggestionRevision={ready ? replyRevision : undefined} showUnavailableActions={!direct} viewerId={profile.id} key={`reply:${thread}`} onSend={(text, document, files, options) => submit(thread, text, document, files, options?.broadcast_confirmed)} onSchedule={canSchedule(thread) ? (text, document, files, at) => scheduleMessage(channel.id, thread, text, document, files, at).then(() => {}) : undefined} mentions={agentTags} uploads={uploads} socket={socket} channel={channel.id} thread={thread} draft={drafts[`thread:${channel.id}:${thread}`]} onDraftChange={document => onDraftChange(`thread:${channel.id}:${thread}`, document)} />}
      </>} />
    </SidePanel>}</AnimatePresence>}
    {status !== 'Disconnected' && sidekick && <SidePanel ref={sidekickPanel} role="region" className="chat-thread chat-agent-sessions" aria-label="My sidekick"><Sidekick drafts={drafts} onDraftChange={onDraftChange} attempt={uploads.attempt} acknowledged={uploads.acknowledged} onAccepted={(key,document)=>uploads.sent(key,document,[])} key={channel.workspace_id} workspace={channel.workspace_id} viewerId={profile.id} source={sidekick.source} onClose={panels.close}/></SidePanel>}
    {status !== 'Disconnected' && sessionView && <SidePanel ref={sessionPanel} key={`sessions:${sessionView.thread}`} role="region" hidden={!sessionOpen} className="chat-thread chat-agent-sessions" aria-label="Agent session">
      <AgentSessions acknowledged={uploads.acknowledged} onAccepted={(key,document)=>uploads.sent(key,document,[])} drafts={drafts} onDraftChange={onDraftChange} attempt={uploads.attempt} thread={sessionView.thread} channel={channel.id} viewerId={profile.id} initialSessionId={sessionView.selected} archived={!!channel.archived_at} channelName={channel.name} onBack={() => openThread(sessionView.thread)} onClose={panels.close} onAccessLost={() => revokeAccess.current(new Error('not_found'))} />
    </SidePanel>}
    {status !== 'Disconnected' && <AnimatePresence>{direct && filesOpen && <ChannelFiles direct={!!direct} key={channel.id} channel={channel.id} name={channel.name} revision={fileRevision} deletions={filesDeleted} onClose={closeFiles} onMessage={fileMessage} onAccessLost={() => revokeAccess.current(new Error('not_found'))} />}</AnimatePresence>}
    {status !== 'Disconnected' && <MessageSearch workspace={channel.workspace_id} channel={{id:channel.id,name:channel.name}} open={channelSearchOpen} editRequest={channelSearchRequest} onChannelSubmit={() => { panels.close(); setSearchMatch(undefined); }} onClose={closeChannelSearch} onSelect={result => {
      setSearchMatch({ id: result.id, thread: result.is_reply ? result.thread_id : undefined });
      if (!result.is_reply && messages.some(message => message.id === result.id)) reveal(result.id);
    }} />}
    {deleteId && status !== 'Disconnected' && <DeleteMessageDialog key={deleteId} onClose={() => setDeleteId(undefined)} onConfirm={() => deleteMessage(deleteId)} />}
    {direct ? <Dialog open={detailsOpen} title={channel.name} onClose={() => setDetailsOpen(false)}><p>Only the participants in this conversation can read and send messages.</p><ul className="dm-details-members">{direct.participants?.map(person => <li key={person.id}><button type="button" className="space-profile-trigger" aria-label={`View ${person.name}’s profile`} onClick={() => {setDetailsOpen(false); profiles?.open({kind:'user',id:person.id});}}><Avatar name={person.name} initials={person.name.slice(0, 2).toUpperCase()} size="sm" /><strong>{person.name}{person.id === profile.id ? ' (you)' : ''}</strong></button></li>)}</ul><Button onClick={onCloseDirect}>Close direct message</Button></Dialog> : <ChannelDetails permissions={permissions.snapshot} permissionsPending={!permissions.snapshot} channel={channel} viewer={profile.id} open={detailsOpen} initialTab={detailsTab} onClose={() => setDetailsOpen(false)} onChange={onChannelChange} onLeft={onLeft} />}
    {!direct && status !== 'Disconnected' && <ChannelMemory channel={channel.id} name={channel.name} open={memoryOpen} message={memoryMessage} onClose={() => { setMemoryOpen(false); setMemoryMessage(undefined); }}
      onOpenThread={id => openThread(id)} onOpenSession={(thread, session) => openSessions(thread, session)} />}
    {selectedMention && status !== 'Disconnected' && <MentionDetails channel={channel.id} mention={selectedMention} onClose={() => setSelectedMention(undefined)} />}
    {sourceId && status !== 'Disconnected' && <SourceMessage direct={!!direct} key={sourceId} channel={channel.id} name={channel.name} messageId={sourceId} onUnavailable={checkSourceAccess} onClose={() => { setSourceId(null); }} />}
  </motion.div>;
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
