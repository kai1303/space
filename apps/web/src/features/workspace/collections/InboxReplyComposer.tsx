import { useEffect, useRef, useState } from 'react';
import type { HubThread } from '@space/contracts';
import { toast } from '@space/ui/primitives';
import type { Socket } from 'socket.io-client';
import { subscribeUpdates } from '../../../shared/realtime/live-updates.js';
import { acquireRealtime } from '../../../shared/realtime/socket-session.js';
import { useChannelPermissions } from '../../channels/useChannelPermissions.js';
import { ThreadComposer } from '../../composer/ThreadComposer.js';
import { OutgoingMessages } from '../../composer/OutgoingMessages.js';
import { getMessageOutbox } from '../../composer/message-outbox.js';
import { scheduleMessage } from '../../composer/scheduled-messages.js';
import type { useAttachmentUploads } from '../../composer/useAttachmentUploads.js';
import type { Profile } from '../../profile/profile-types.js';

export function InboxReplyComposer({ item, workspace, profile, attachments }: {
  item: HubThread; workspace: string; profile: Profile; attachments: ReturnType<typeof useAttachmentUploads>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const [socket, setSocket] = useState<Socket>();
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), {rootMargin:'160px'});
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  const mounted = visible || focused;
  useEffect(() => {
    if (!mounted) return;
    const connection = acquireRealtime();
    setSocket(connection.socket);
    const stopTyping = subscribeUpdates('thread',item.thread_id,()=>{});
    connection.connect();
    return () => { stopTyping(); connection.release(); setSocket(undefined); };
  }, [mounted,item.thread_id]);
  const direct = item.channel_kind === 'direct';
  const permissions = useChannelPermissions(mounted && !direct ? item.channel_id : undefined, workspace);
  const canReply = direct || !!permissions.snapshot?.capabilities.reply;
  const canShare = direct || !!permissions.snapshot?.capabilities.post;
  const key = `thread:${item.channel_id}:${item.thread_id}`;
  const outbox = getMessageOutbox(profile.id, workspace);
  const reportError = (reason:unknown) => toast.error(reason instanceof Error ? reason.message : 'Delivery failed.');
  return <div ref={host} className="thread-inline-composer" onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {item.encrypted_since || item.archived_at ? <p>{item.archived_at ? 'This conversation is archived.' : 'Replies are unavailable in an encrypted conversation.'}</p>
      : mounted && socket ? <>
        <OutgoingMessages outbox={outbox} channel={item.channel_id} thread={item.thread_id} profile={profile}
          history={item.recent_replies} retryDisabled={!canReply}
          onRetry={(entry,confirmed)=>void outbox.send(entry.id,socket,confirmed || entry.broadcastConfirmed).catch(reportError)}
          onDelete={entry=>void outbox.discard(entry.id).catch(reportError)}/>
        <ThreadComposer editorLabel={`Reply to thread ${direct ? 'with' : 'in'} ${item.channel_name}`} workspace={workspace} channel={item.channel_id} thread={item.thread_id}
          broadcastDestination={canShare && canReply ? direct ? 'this conversation' : '#'+item.channel_name : undefined}
          viewerId={profile.id} uploads={attachments.uploads} socket={socket} draft={attachments.draftState.current[key]}
          mentions={[]} sendDisabled={!canReply} sendDisabledReason={permissions.error || (permissions.snapshot && !canReply ? 'Replies are restricted in this conversation.' : undefined)}
          suggestionRevision={item.latest_sequence}
          onDraftChange={document=>attachments.saveDraft(key,document)}
          onSchedule={canReply ? async (text, document, files, at, share) => { await scheduleMessage(item.channel_id,item.thread_id,text,document,files,at,share); } : undefined}
          onSend={async (text,document,files,options,share)=>{
            if (!canReply || (share && !canShare)) throw new Error('Posting is restricted in this conversation.');
            attachments.uploads.attempt(key);
            await outbox.enqueue({channelId:item.channel_id,threadId:item.thread_id,text,document,attachments:files,broadcastConfirmed:options?.broadcast_confirmed,alsoSendToChannel:share});
            attachments.uploads.sent(key,document,files);
          }}/>
      </> : <div className="thread-editor-placeholder" aria-hidden="true">Reply…</div>}
  </div>;
}
