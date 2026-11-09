import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { ChatMessage } from '@space/contracts';
import { Message } from '@space/ui/conversation';
import { RichContent } from '@space/ui/rich-text';
import type { Profile } from '../profile/profile-types.js';
import type { getMessageOutbox, OutboxEntry } from './message-outbox.js';

const deliveryErrors: Record<string, string> = {
  channel_posting_forbidden: 'Posting is restricted in this channel.',
  channel_replies_forbidden: 'Replies are restricted in this thread.',
  channel_broadcast_forbidden: 'You don’t have permission to notify the whole channel.',
  channel_archived: 'This channel has been archived.',
  direct_message_participant_inactive: 'A participant in this conversation is inactive.',
  asset_unavailable: 'An attachment is no longer available.',
  broadcast_confirmation_required: 'This mention will notify everyone in the channel.',
};

type Props = {
  outbox: ReturnType<typeof getMessageOutbox>;
  profile: Profile;
  channel: string;
  thread?: string;
  history: readonly ChatMessage[];
  retryDisabled: boolean;
  onDelete: (entry: OutboxEntry) => void;
  onRetry: (entry: OutboxEntry, confirmBroadcast: boolean) => void;
};

export function useOutgoingMessages({ outbox, profile, channel, thread, history }: Pick<Props, 'outbox' | 'profile' | 'channel' | 'thread' | 'history'>) {
  const entries = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot);
  useLayoutEffect(() => { outbox.reconcile(history); }, [outbox, history]);
  const committed = new Set(history.filter(message => message.author.kind === 'human' && message.author.id === profile.id).map(message => message.client_message_id));
  return entries.filter(entry => entry.channelId === channel && entry.threadId === thread && (!committed.has(entry.id) || entry.status === 'deleting' || entry.status === 'delete_failed'));
}

export function OutgoingMessages(props: Props) {
  const visible = useOutgoingMessages(props);
  const lastId = visible.at(-1)?.id;
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!lastId) return;
    const timeline = list.current?.closest('.chat-timeline');
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [lastId]);
  if (!visible.length) return null;
  return <div ref={list}>{visible.map(entry => <OutgoingMessage key={entry.id} entry={entry} {...props}/>)}</div>;
}

export function OutgoingMessage({ entry, grouped, profile, retryDisabled, onDelete, onRetry }: Pick<Props, 'profile' | 'retryDisabled' | 'onDelete' | 'onRetry'> & { entry: OutboxEntry; grouped?: boolean }) {
  if (entry.status === 'deleting' || entry.status === 'delete_failed') {
    return <div className="chat-delivery-actions chat-cancel-outgoing">
      <span role="status">{entry.status === 'deleting' ? 'Deleting message…' : 'Couldn’t delete this message.'}</span>
      {entry.status === 'delete_failed' && <button type="button" onClick={() => onDelete(entry)}>Retry delete</button>}
    </div>;
  }
  const confirm = entry.error === 'broadcast_confirmation_required';
  return <div className="chat-outgoing" data-delivery={entry.status}>
    <Message grouped={grouped} author={profile.display_name} initials={profile.display_name.slice(0, 2).toUpperCase()} tone="blue"
      time={new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      footer={entry.status === 'failed' && <div className="chat-delivery-actions">
        <span role="status">{deliveryErrors[entry.error ?? ''] ?? 'Delivery unconfirmed.'}</span>
        <button type="button" disabled={retryDisabled} onClick={() => onRetry(entry, confirm)}>{confirm ? 'Notify everyone and send' : 'Retry'}</button>
        <button type="button" onClick={() => onDelete(entry)}>Delete</button>
      </div>}>
      {entry.document ? <RichContent document={entry.document} viewerId={profile.id}/> : entry.text}
      {entry.attachments.map(file => <div key={file.id}>{file.name}</div>)}
    </Message>
  </div>;
}
