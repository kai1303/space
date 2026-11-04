import type { Snapshot } from '../../shared/ui/view-state.js';
import type { ConversationView } from './view-state.js';
import { useStarredChannels } from '../channels/useStarredChannels.js';
import { ThreadNotificationToggle } from '../notifications/Notifications.js';
import { ConversationHeader, ConversationMessage } from './ThreadConversation.js';
import { AgentSessions } from '../agents/AgentSessions.js';
import { TypingIndicator, useTypingPublisher } from './typing.js';
import { acquireRealtime } from '../../shared/realtime/socket-session.js';
import { MentionDetails, useMentionSearch } from "../mentions/Mentions.js";
import { NavigatorSettings, NavigatorSuggestions, agentMention } from '../agents/Navigator.js';
import { MessageTimeline, type TimelineHandle } from './MessageTimeline.js';
import { useMessageHistory } from './useMessageHistory.js';
import { useChannelRead } from './useChannelRead.js';
import { ChannelFiles } from '../files/ChannelFiles.js';
import { ChannelMemory } from '../memory/ChannelMemory.js';
import { SourceMessage } from './SourceMessage.js';
import { ChannelDetails } from '../channels/ChannelDetails.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ChannelUnread, MentionReference, NavigatorCandidate, ChatEvent, ChatHistory, ChatMessage, DirectMessageSummary } from '@space/contracts';
import { Avatar, Button, Dialog, IconButton, Menu, SidePanel } from '@space/ui/primitives';
import { Message, useMessageArrivals } from '@space/ui/conversation';
import { RichComposer } from '@space/ui/composer';
import { MessageSearch } from '../search/MessageSearch.js';
import { motionTransition } from '@space/ui/motion';
import { type RichDocument } from '@space/ui/rich-text';
import { Archive, BookOpen, ChatCircle, DotsThree, Hash, Lock, MagnifyingGlass, Paperclip, Robot, Users, X, Star } from '@phosphor-icons/react';
import { socketCommand as command } from '../../shared/realtime/socket-command.js';
import { mergeEvents } from './merge-events.js';
import { messageSender } from '../composer/message-sender.js';
import { request } from '../../shared/api/request.js';
import type { ChannelSummary as Channel } from '@space/contracts';
import type { Profile } from '../profile/profile-types.js';
import { errorText } from '../../shared/api/error-text.js';
import { ConversationSkeleton } from './ConversationSkeleton.js';
import { ThreadHistory } from './ThreadHistory.js';
import { ThreadComposer } from '../composer/ThreadComposer.js';
import { TaskActivity } from '../agents/TaskActivity.js';
import { messageTodoId } from '../todos/message-todo-id.js';
import { type UploadDrafts } from '../composer/useAttachmentUploads.js';

export function ChannelRoom({ viewState, requestedThread, onCloseDirect, readState, uploads, profile, channel, onChannelChange, onLeft, drafts, onDraftChange, onAccessLost, searchOpen, onSearchClose, composeRequest, mentionTarget, onMentionOpened }: { viewState?:Snapshot<ConversationView>; requestedThread?: string; onCloseDirect?: () => void; readState?: ChannelUnread; uploads: UploadDrafts; profile: Profile; channel: Channel; onChannelChange: (channel: Channel) => void; onLeft: () => void; drafts: Record<string, RichDocument>; onDraftChange: (key: string, document: RichDocument) => void; onAccessLost: () => void; searchOpen: boolean; onSearchClose: () => void; composeRequest: number; mentionTarget?: string; onMentionOpened: () => void }) {
  const direct = channel.kind === 'direct' ? channel as DirectMessageSummary : undefined;
  const selfDirect = direct?.participants.length === 1 && direct.participants[0]?.id === profile.id;
  const starred = useStarredChannels(channel.workspace_id, channel.id);
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
  const [thread, setThread] = useState<string|undefined>(requestedThread??(!mentionTarget?viewState?.current.thread:undefined)), [socket, setSocket] = useState<Socket>();
  const [navCandidates,setNavCandidates]=useState<NavigatorCandidate[]>([]);
  const agentTags=[...new Set(navCandidates.map(c=>agentMention(c,navCandidates)))];
  const [channelSearchOpen, setChannelSearchOpen] = useState(false), [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState('about');
  const showDetails = (tab = 'about') => { setDetailsTab(tab); setDetailsOpen(true); };
  const [filesOpen, setFilesOpen] = useState(false);
  const filesButton = useRef<HTMLButtonElement>(null);
  const [sessionView, setSessionView] = useState<{ thread: string; selected: string }|undefined>(!requestedThread&&!mentionTarget?viewState?.current.sessionView:undefined);
  const [sessionOpen, setSessionOpen] = useState(!requestedThread&&!mentionTarget&&!!viewState?.current.sessionOpen);
  useLayoutEffect(()=>{if(viewState)viewState.current={thread,sessionView,sessionOpen};},[viewState,thread,sessionView,sessionOpen]);
  const threadPanel = useRef<HTMLElement>(null), sessionPanel = useRef<HTMLElement>(null);
  const panelTrigger = useRef<HTMLElement | null>(null), focusedPanel = useRef<HTMLElement | null>(null);
  function rememberPanelTrigger() {
    const source = document.activeElement;
    if (source instanceof HTMLElement && !source.closest('.chat-thread')) panelTrigger.current = source;
  }
  useLayoutEffect(() => {
    const panel = sessionOpen ? sessionPanel.current : thread ? threadPanel.current : null;
    if (panel) panel.focus({ preventScroll: true });
    else if (focusedPanel.current && (document.activeElement === document.body || focusedPanel.current.contains(document.activeElement))) {
      const trigger = panelTrigger.current;
      const target = trigger?.isConnected && !trigger.closest('[inert], [hidden], [aria-hidden="true"]') ? trigger : document.getElementById('chat-messages');
      target?.focus({ preventScroll: true });
    }
    focusedPanel.current = panel;
  }, [thread, sessionOpen, sessionView?.selected]);
  const channelTyping=useTypingPublisher(socket,channel.id,undefined,ready&&!channel.archived_at&&!sessionOpen&&!(compact&&thread));
  function openThread(id: string) {
    rememberPanelTrigger();
    setSessionOpen(false); setThread(id); setFilesOpen(false);
  }
  useEffect(() => { if (requestedThread) { openThread(requestedThread); onMentionOpened(); } }, [requestedThread]);
  function openSessions(threadId: string, selected: string) {
    rememberPanelTrigger();
    setThread(undefined); setFilesOpen(false);
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
    setThread(undefined); setSessionOpen(false); setFilesOpen(false);
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
    historyLoaded && ready && !history.loading && !history.page?.has_newer && atEnd && !searchOpen && !channelSearchOpen && !filesOpen && !sourceId && !detailsOpen && !memoryOpen && !selectedMention && !sessionOpen);
  const firstUnread = entryRead.current === undefined ? undefined : messages.find(message => message.author.id !== profile.id && BigInt(message.sequence ?? '0') > BigInt(entryRead.current!))?.id;
  const arrivals = useMessageArrivals(messages, historyLoaded && !history.loading ? channel.id : null);
  const conversations = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const entries = conversations.get(message.thread_id) ?? [];
    entries.push(message); conversations.set(message.thread_id, entries);
  }
  function reveal(id: string) {
    setThread(undefined);
    setSessionOpen(false);
    setFilesOpen(false);

    requestAnimationFrame(() => timeline.current?.reveal(id));
  }
  function closeFiles() { setFilesOpen(false); requestAnimationFrame(() => filesButton.current?.focus()); }
  function toggleFiles() {
    if (filesOpen) { closeFiles(); return; }
    setThread(undefined); setSessionOpen(false); setFilesOpen(true);
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
    return <div key={m.id} id={`${inThread ? 'thread' : 'chat'}-message-${m.id}`} tabIndex={-1} className="chat-message-anchor"><ConversationMessage message={m} viewerId={profile.id} arrival={arriving} onReact={channel.archived_at ? undefined : emoji => { void react(m, emoji); }} actions={{ save: () => request(`/workspaces/${channel.workspace_id}/hub/saved/${m.id}`, { channel_id: channel.id, active: true }).then(() => {}), addTodo: async () => { const id = await messageTodoId(profile.id, m.id); await request(`/workspaces/${channel.workspace_id}/hub/todos/${id}`, {title: m.text.trim().slice(0,500) || 'Shared a file', ...(m.document && m.text.trim().length <= 500 ? {document: m.document} : {}), channel_id: channel.id, message_id: m.id, completed: false, create_only: true}); }, copyMessage: () => navigator.clipboard.writeText(m.text), ...(!direct ? { saveMemory: () => { setMemoryMessage({ id: m.id, text: m.text }); setMemoryOpen(true); } } : {}) }} onReply={inThread ? undefined : () => openThread(m.thread_id)} replyCount={!inThread ? m.reply_count ?? (replies[0]?.id === m.id ? replies.length - 1 : 0) : 0} onMentionClick={setSelectedMention} footer={!inThread && m.agent_sessions?.map(session => <button key={session.id} type="button" className="sp-thread-link chat-session-link" aria-label={`Agent session: ${session.title}`} title={session.title} onClick={() => openSessions(m.thread_id, session.id)}><Robot size={14} aria-hidden="true" />Agent session<span>{session.title}</span></button>)}/></div>;
  }
  return <motion.div initial={false} animate={{ opacity: reduced || historyLoaded || status === 'Disconnected' ? 1 : .65 }} transition={motionTransition(reduced)} className={`chat-conversation ${thread ? 'chat-conversation--thread' : ''} ${filesOpen ? 'chat-conversation--files' : ''}`}><main className="chat-channel" id="chat-messages" tabIndex={-1} aria-hidden={compact && (thread || sessionOpen) ? true : undefined} inert={compact && !!(thread || sessionOpen)}><header className="chat-channel-header"><div className="chat-channel-heading"><IconButton label={starred.active ? 'Unstar conversation' : 'Star conversation'} onClick={() => void starred.toggle(channel.id).catch(reason => setError(errorText(reason)))}><Star size={19} weight={starred.active ? 'fill' : 'regular'}/></IconButton><button className="chat-channel-title" aria-label={direct ? `Conversation details for ${channel.name}` : `Channel details for #${channel.name}`} onClick={() => showDetails()}>{direct ? <Avatar name={channel.name} initials={channel.name.slice(0, 2).toUpperCase()} image={(direct.participants.find(person => person.id !== profile.id) ?? direct.participants[0])?.image} /> : channel.private ? <Lock size={20} weight="bold" /> : <Hash size={22} weight="bold" />}<h1>{channel.name}</h1></button></div>{channel.topic && <button className="chat-channel-topic" title={channel.topic} onClick={() => showDetails()}>{channel.topic}</button>}<div className="chat-header-actions">{!direct && <button className="chat-channel-member-button" aria-label="View channel members" onClick={() => showDetails('members')}><Users size={18} /> Members</button>}<IconButton label={`Search in ${channel.name}`} onClick={() => setChannelSearchOpen(true)}><MagnifyingGlass size={20} /></IconButton>{direct && <Menu label="More conversation actions" floating trigger={<DotsThree size={22} weight="bold" />} items={[{ label: 'Conversation details', onSelect: () => showDetails() }, { label: 'Browse files', onSelect: () => { if (!filesOpen) toggleFiles(); } }, ...(onCloseDirect ? [{ label: 'Close direct message', separatorBefore: true, onSelect: onCloseDirect }] : [])]} />}{direct && onCloseDirect && <IconButton label="Close direct message" onClick={onCloseDirect}><X size={20} /></IconButton>}</div></header>
    <div className="chat-channel-tabs"><span><ChatCircle size={15} /> Messages</span><button ref={filesButton} className="chat-files-tab" aria-expanded={filesOpen} disabled={!historyLoaded || status === 'Disconnected'} onClick={toggleFiles}><Paperclip size={15} /> Files</button>{!direct && <><button disabled={status === 'Disconnected'} onClick={() => { setMemoryMessage(undefined); setMemoryOpen(true); }}><BookOpen size={15} /> Memory</button><NavigatorSettings channel={channel.id} onCandidates={setNavCandidates} /></>}{channel.archived_at && <span className="chat-channel-privacy"><Archive size={14} /> Archived</span>}</div>
    {error && <p className="chat-error" role="alert">{error}{!historyLoaded && status !== 'Disconnected' && <Button size="sm" disabled={!!history.loading} onClick={() => { setError(''); history.clear(); setHistoryAttempt(value => value + 1); }}>Retry loading messages</Button>}</p>}
    {readError && <p role="status">{readError}</p>}
    <MessageTimeline onAtEndChange={setAtEnd} label={`Messages in ${channel.name}`} items={visibleEvents} page={history.page} loading={history.loading} latestVersion={history.latestVersion} load={history.load} pinned={stickToBottom} handle={timeline} busy={!historyLoaded && status !== 'Disconnected'} render={(event, index) => <>{(!index || new Date(visibleEvents[index - 1]!.occurred_at).toDateString() !== new Date(event.occurred_at).toDateString()) && <div className="chat-date-divider"><span>{new Date(event.occurred_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>}{event.type === 'message.created' && event.payload.id === firstUnread && <div className="chat-unread-divider" role="separator" aria-label="New messages"><span>New messages</span></div>}{event.type === 'message.created' ? message(event.payload) : event.type === 'task.event' ? <TaskActivity event={event} profile={profile} onOpenWorkspace={() => openAgentSession(event)} onThread={() => openThread(event.thread_id)} /> : null}</>}>
      {!historyLoaded && status !== 'Disconnected' ? <><p className="chat-loading-status" role="status" aria-label="Loading messages">Loading messages…</p><ConversationSkeleton /></> : !messages.length && <div className={`chat-channel-welcome${direct ? ' dm-conversation-intro' : ''}`}><div className="chat-empty-icon">{direct ? <Avatar name={channel.name} initials={channel.name.slice(0, 2).toUpperCase()} image={(direct.participants.find(person => person.id !== profile.id) ?? direct.participants[0])?.image} size="lg" tone="blue" /> : <Hash size={38} />}</div><h2>{ready ? direct ? channel.name : `This is the beginning of #${channel.name}` : status === 'Disconnected' ? 'This conversation is unavailable' : `Opening ${direct ? '' : '#'}${channel.name}`}</h2><p>{ready ? direct ? direct.participants?.length === 1 ? 'Your space for notes, links, and files.' : `This is the beginning of your conversation with ${channel.name}.` : 'A shared space for your team’s ideas, questions, and progress. Send the first message.' : status === 'Disconnected' ? 'Your access may have changed. Select another conversation to continue.' : 'Getting your conversation ready…'}</p></div>}
    </MessageTimeline>{!direct&&!thread&&!sessionOpen&&!channel.archived_at&&status!=='Disconnected'&&<NavigatorSuggestions channel={channel.id} onThread={openThread} />}{channel.archived_at ? <div className="chat-channel-archived"><strong>This channel is archived</strong>Its messages are available to read.<br /><Button size="sm" onClick={() => showDetails('settings')}>View channel settings</Button></div> : status !== 'Disconnected' && <div className="chat-compose" onBlurCapture={channelTyping.blur}><TypingIndicator channel={channel.id} viewerId={profile.id} enabled={ready}/><RichComposer showUnavailableActions={!direct} findMentions={findMentions} mentions={agentTags} attachmentsEnabled={uploads.enabled} attachments={uploads.drafts[channel.id] ?? []} onAttachmentsChange={files => uploads.change(channel.id, channel.id, files)} onRetryAttachment={id => uploads.retry(channel.id, channel.id, id)} channel={channel.name} placeholder={selfDirect ? 'Jot something down' : direct ? `Message ${channel.name}` : undefined} acknowledgedDocument={uploads.acknowledged[channel.id]} defaultValue={drafts[channel.id]} onDraftChange={document => {onDraftChange(channel.id, document);channelTyping.change(document);}} onSend={async (text, document, files, options) => { const saved = await send(text, document, files.map(file => file.id), options?.broadcast_confirmed); channelTyping.stop(); window.dispatchEvent(new Event('space:mentions-changed')); uploads.sent(channel.id, document, files); history.sent(saved); }} /></div>}</main>
    {status !== 'Disconnected' && <AnimatePresence>{thread && <SidePanel ref={threadPanel} key="thread" role="region" className="chat-thread" aria-label="Thread"><ConversationHeader title="Thread" actions={<ThreadNotificationToggle key={thread} thread={thread}/>} channel={direct ? undefined : channel.name} status={direct ? channel.name : undefined} onClose={() => setThread(undefined)} />
      <ThreadHistory key={thread} thread={thread} channel={channel.id} live={threadLive} renderMessage={(m, arriving) => message(m, true, arriving)} activity={[...activity.values()].filter(event => event.thread_id === thread && !event.payload.data.session_managed)} profile={profile} onOpenWorkspace={openAgentSession} onAccessLost={reason => revokeAccess.current(reason)} footer={<>
      {!direct && <NavigatorSuggestions channel={channel.id} thread={thread} />}
      {socket && !channel.archived_at && <ThreadComposer showUnavailableActions={!direct} viewerId={profile.id} key={`reply:${thread}`} onSent={saved => { history.receive([saved], stickToBottom.current); threadLive.current?.([saved], true); }} mentions={agentTags} uploads={uploads} socket={socket} channel={channel.id} thread={thread} draft={drafts[`thread:${channel.id}:${thread}`]} onDraftChange={document => onDraftChange(`thread:${channel.id}:${thread}`, document)} />}
      </>} />
    </SidePanel>}</AnimatePresence>}
    {status !== 'Disconnected' && sessionView && <SidePanel ref={sessionPanel} key={`sessions:${sessionView.thread}`} role="region" hidden={!sessionOpen} className="chat-thread chat-agent-sessions" aria-label="Agent session">
      <AgentSessions acknowledged={uploads.acknowledged} onAccepted={(key,document)=>uploads.sent(key,document,[])} drafts={drafts} onDraftChange={onDraftChange} attempt={uploads.attempt} thread={sessionView.thread} channel={channel.id} viewerId={profile.id} initialSessionId={sessionView.selected} archived={!!channel.archived_at} channelName={channel.name} onBack={() => openThread(sessionView.thread)} onClose={() => setSessionOpen(false)} onAccessLost={() => revokeAccess.current(new Error('not_found'))} />
    </SidePanel>}
    {status !== 'Disconnected' && <AnimatePresence>{filesOpen && <ChannelFiles direct={!!direct} key={channel.id} channel={channel.id} name={channel.name} revision={fileRevision} onClose={closeFiles} onMessage={fileMessage} onAccessLost={() => revokeAccess.current(new Error('not_found'))} />}</AnimatePresence>}
    {status !== 'Disconnected' && <MessageSearch workspace={channel.workspace_id} channel={{id:channel.id,name:channel.name}} open={channelSearchOpen} onClose={() => { setChannelSearchOpen(false); onSearchClose(); }} onSelect={result => { setThread(result.is_reply ? result.thread_id : undefined); setSessionOpen(false); setFilesOpen(false); setSourceId(result.id); }} />}
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
