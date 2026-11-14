import {useSavedMessages} from './useSavedMessages.js';
import { ConversationReplyDivider } from './ThreadConversation.js';
import { request } from '../../shared/api/request.js';
import { useChannelRead } from './useChannelRead.js';
import { ConversationSkeleton } from './ConversationSkeleton.js';
import { MessageTimeline } from './MessageTimeline.js';
import { useMessageHistory } from './useMessageHistory.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatEvent, ChatMessage } from '@space/contracts';
import { Button } from '@space/ui/primitives';
import { useMessageArrivals } from '@space/ui/conversation';
import { mergeEvents } from './merge-events.js';
import type { Profile } from '../profile/profile-types.js';
import { errorText } from '../../shared/api/error-text.js';
import { TaskActivity } from '../agents/TaskActivity.js';

export function ThreadHistory({ channelHistoryLoaded, workspace, thread, channel, target, live, renderMessage, activity, profile, onAccessLost, onOpenWorkspace, renderOutgoing, footer }: { channelHistoryLoaded:boolean; workspace:string; thread: string; channel: string; target?: ChatMessage; live: { current: ((messages: ChatMessage[], sent?: boolean) => void) | null }; renderMessage: (message: ChatMessage, arriving: boolean) => React.ReactNode; activity: ChatEvent[]; profile: Profile; onAccessLost: (reason: unknown) => void; onOpenWorkspace: (event: ChatEvent & { type: 'task.event' }) => void; renderOutgoing?: (history: ChatMessage[]) => ReactNode; footer?: React.ReactNode }) {
  const pinned = useRef(true);
  const [error, setError] = useState('');
  const history = useMessageHistory(`/threads/${thread}/history`, reason => {
    if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) onAccessLost(reason);
    else setError(errorText(reason));
  }, false, target);
  const [parent,setParent] = useState<ChatMessage>();
  const parentVersion = useRef(0), started = useRef(false);
  useEffect(() => {
    live.current = (messages, sent) => { const matching = messages.filter(message => message.thread_id === thread); const root = matching.findLast(m => m.id === m.thread_root_id);
      if (root) { parentVersion.current++; setParent(root); }
      if (sent) { for (const message of matching) history.sent(message); } else history.receive(matching, pinned.current); };
    return () => { started.current=false; live.current = null; history.clear(); };
  }, [thread]);
  useEffect(() => {
    // Establish the channel replay cursor before taking the thread snapshot.
    // The buffer and reconnect replay cover messages arriving during the read.
    if (channelHistoryLoaded && !started.current) { started.current = true; void history.load('latest'); }
  },[thread,channelHistoryLoaded,history.load]);
  const messages = (history.page?.messages ?? []).filter(message => !message.agent_session_id);
  const rootId = messages.find(message => message.thread_root_id)?.thread_root_id ?? (!history.page?.has_older ? messages[0]?.id : undefined);
  // Latest history is bounded. Keep the original question available even when its
  // creation is outside the loaded page; a newer edit/deletion wins over this read.
  const missingParent = rootId && !messages.some(m=>m.id===rootId) ? rootId : undefined;
  useEffect(()=>{
    if (!missingParent) return;
    const controller = new AbortController(), version=parentVersion.current;
    void request<ChatMessage>(`/channels/${channel}/messages/${missingParent}`,undefined,undefined,'POST',controller.signal,profile.id)
      .then(value=>{ if (!controller.signal.aborted && version===parentVersion.current && value.thread_id===thread) setParent(value); })
      .catch(reason=>{ if (!controller.signal.aborted) setError(errorText(reason)); });
    return ()=>controller.abort();
  },[missingParent,channel,thread,profile.id]);
  const bookmarks=useSavedMessages(workspace,channel,profile.id,missingParent && parent?.id===missingParent?[...messages,parent]:messages);
  const withSaved=(m:ChatMessage)=>({...m,viewer_saved:bookmarks?.has(m.id)});
  const [atEnd,setAtEnd] = useState(true);
  const latest = messages.filter(m => m.id !== rootId && !m.deleted_at).at(-1)?.sequence ?? '0';
  const readError = useChannelRead(channel,latest,'0',atEnd && !history.loading && !history.page?.has_newer, {workspace,id:thread,actor:profile.id});
  const summary = messages.reduce<ChatMessage['reply_summary']>((latest,m) => m.reply_summary && BigInt(m.reply_summary.revision)>BigInt(latest?.revision ?? '-1') ? m.reply_summary : latest, parent?.reply_summary);
  const replyCount = summary?.count ?? Math.max(0,parent?.reply_count ?? 0, ...messages.map(message => message.reply_count ?? 0), messages.filter(message => message.id !== rootId && !message.deleted_at).length);
  const messageEvents: ChatEvent[] = messages.map(message => ({ type: 'message.created', channel_id: channel, thread_id: thread, sequence: message.sequence!, occurred_at: message.created_at, payload: message }));
  const savedResponses = new Set(messages.filter(message => message.agent_response).map(message => message.task_id));
  const items = mergeEvents(messageEvents, (history.page ? activity : []).filter(event => (event.type !== 'task.event' || !savedResponses.has(event.payload.task_id)) && (!history.page?.has_older || BigInt(event.sequence) >= BigInt(history.page.older_cursor ?? '0')) && (!history.page?.has_newer || BigInt(event.sequence) <= BigInt(history.page.newer_cursor ?? '0'))));
  // Keep each task mounted across progress events. Its saved reply inherits the same arrival identity.
  const rows = items.map(event => event.type === 'task.event' ? { ...event, id: `task:${event.payload.task_id}` } : event);
  function arrivalId(event: ChatEvent) {
    if (event.type === 'task.event') return `${event.payload.data.response ? 'reply' : 'activity'}:${event.payload.task_id}`;
    if (event.payload.agent_response && event.payload.task_id) return `reply:${event.payload.task_id}`;
    return event.payload.id;
  }
  const arrivals = useMessageArrivals(rows.map(event => ({ id: arrivalId(event) })), history.page && !history.loading ? thread : null);
  return <>{readError && <p role="status">{readError}</p>}{error && <p role="alert">{error} <Button size="sm" onClick={() => { setError(''); void history.load('latest'); }}>Retry thread history</Button></p>}<MessageTimeline header={missingParent && parent?.id===missingParent ? <>{renderMessage(withSaved(parent),false)}<ConversationReplyDivider count={replyCount}/></> : undefined} onAtEndChange={setAtEnd} target={target} label="Thread messages" items={rows} page={history.page} loading={history.loading} latestVersion={history.latestVersion} load={history.load} pinned={pinned} trailing={history.page && renderOutgoing?.(messages)} footer={footer} busy={!history.page && !error} render={event => event.type === 'message.created' ? <>{renderMessage(withSaved(event.payload), arrivals.has(arrivalId(event)))}{event.payload.id === rootId && replyCount > 0 && <ConversationReplyDivider count={replyCount} />}</> : event.type === 'task.event' ? <TaskActivity newArrival={arrivals.has(arrivalId(event))} event={event} profile={profile} onOpenWorkspace={() => onOpenWorkspace(event)} /> : null}>{!history.page && !error && <ConversationSkeleton label="Loading thread" />}</MessageTimeline></>;
}
