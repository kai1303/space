import { ConversationReplyDivider } from './ThreadConversation.js';
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

export function ThreadHistory({ thread, channel, target, live, renderMessage, activity, profile, onAccessLost, onOpenWorkspace, renderOutgoing, footer }: { thread: string; channel: string; target?: ChatMessage; live: { current: ((messages: ChatMessage[], sent?: boolean) => void) | null }; renderMessage: (message: ChatMessage, arriving: boolean) => React.ReactNode; activity: ChatEvent[]; profile: Profile; onAccessLost: (reason: unknown) => void; onOpenWorkspace: (event: ChatEvent & { type: 'task.event' }) => void; renderOutgoing?: (history: ChatMessage[]) => ReactNode; footer?: React.ReactNode }) {
  const pinned = useRef(true);
  const [error, setError] = useState('');
  const history = useMessageHistory(`/threads/${thread}/history`, reason => {
    if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) onAccessLost(reason);
    else setError(errorText(reason));
  }, false, target);
  useEffect(() => {
    live.current = (messages, sent) => { const matching = messages.filter(message => message.thread_id === thread); if (sent) { for (const message of matching) history.sent(message); } else history.receive(matching, pinned.current); };
    void history.load('latest');
    return () => { live.current = null; history.clear(); };
  }, [thread]);
  const messages = (history.page?.messages ?? []).filter(message => !message.agent_session_id);
  const rootId = messages.find(message => message.thread_root_id)?.thread_root_id ?? (!history.page?.has_older ? messages[0]?.id : undefined);
  const replyCount = Math.max(0, ...messages.map(message => message.reply_count ?? 0), messages.filter(message => message.id !== rootId).length);
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
  return <>{error && <p role="alert">{error} <Button size="sm" onClick={() => { setError(''); void history.load('latest'); }}>Retry thread history</Button></p>}<MessageTimeline target={target} label="Thread messages" items={rows} page={history.page} loading={history.loading} latestVersion={history.latestVersion} load={history.load} pinned={pinned} trailing={history.page && renderOutgoing?.(messages)} footer={footer} busy={!history.page && !error} render={event => event.type === 'message.created' ? <>{renderMessage(event.payload, arrivals.has(arrivalId(event)))}{event.payload.id === rootId && replyCount > 0 && <ConversationReplyDivider count={replyCount} />}</> : event.type === 'task.event' ? <TaskActivity newArrival={arrivals.has(arrivalId(event))} event={event} profile={profile} onOpenWorkspace={() => onOpenWorkspace(event)} /> : null}>{!history.page && !error && <p role="status">Loading thread…</p>}</MessageTimeline></>;
}
