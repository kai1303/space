import { ConversationComposer } from '../chat/ThreadConversation.js';
import { TypingIndicator, useTypingPublisher } from '../chat/typing.js';
import { useMentionSearch } from "../mentions/Mentions.js";
import { request } from '../../shared/api/request.js';
import { useMemo } from 'react';
import type { Socket } from 'socket.io-client';
import type { ChatMessage } from '@space/contracts';
import { type RichDocument } from '@space/ui/rich-text';
import { messageSender } from './message-sender.js';
import { type UploadDrafts } from './useAttachmentUploads.js';

export function ThreadComposer({ sendDisabledReason, suggestionRevision, showUnavailableActions = true, viewerId, mentions, uploads, socket, channel, thread, draft, onDraftChange, onSent }: {sendDisabledReason?: string; suggestionRevision?: string; showUnavailableActions?:boolean; viewerId:string; onSent: (message: ChatMessage) => void; mentions: string[]; uploads: UploadDrafts; socket: Socket; channel: string; thread: string; draft?: RichDocument; onDraftChange: (document: RichDocument) => void }) {
  const send = useMemo(() => messageSender(socket, channel, thread, uploads.attempt(`thread:${channel}:${thread}`)), [socket, channel, thread]);
  const loadReplySuggestion = useMemo(() => {
    if (suggestionRevision === undefined) return undefined;
    return async (signal: AbortSignal) => {
      const result = await request<{ suggestion: string | null }>(`/threads/${thread}/reply-suggestion`, {}, undefined, 'POST', signal);
      return result.suggestion;
    };
  }, [thread, suggestionRevision]);
  const findMentions = useMentionSearch(channel);
  const typing=useTypingPublisher(socket,channel,thread);
  return <div onBlurCapture={typing.blur}><ConversationComposer sendDisabledReason={sendDisabledReason} loadReplySuggestion={loadReplySuggestion} showUnavailableActions={showUnavailableActions} typingIndicator={<TypingIndicator channel={channel} thread={thread} viewerId={viewerId}/>} findMentions={findMentions} mentions={mentions} attachmentsEnabled={uploads.enabled} attachments={uploads.drafts[`thread:${channel}:${thread}`] ?? []} onAttachmentsChange={files => uploads.change(`thread:${channel}:${thread}`, channel, files)} onRetryAttachment={id => uploads.retry(`thread:${channel}:${thread}`, channel, id)} channel="thread" acknowledgedDocument={uploads.acknowledged[`thread:${channel}:${thread}`]} defaultValue={draft} onDraftChange={document=>{onDraftChange(document);typing.change(document);}} onSend={async (text, document, files, options) => { if (sendDisabledReason) throw new Error(sendDisabledReason); const saved = await send(text, document, files, options?.broadcast_confirmed);typing.stop(); window.dispatchEvent(new Event('space:mentions-changed')); uploads.sent(`thread:${channel}:${thread}`, document, files); onSent(saved); }} /></div>;
}
