import { ConversationComposer } from '../chat/ThreadConversation.js';
import { TypingIndicator, useTypingPublisher } from '../chat/typing.js';
import { useMentionSearch } from "../mentions/Mentions.js";
import { request } from '../../shared/api/request.js';
import { useMemo, type ComponentProps } from 'react';
import type { Socket } from 'socket.io-client';
import { type RichDocument } from '@space/ui/rich-text';
import { type UploadDrafts } from './useAttachmentUploads.js';

export function ThreadComposer({ workspace, sendDisabled, sendDisabledReason, suggestionRevision, viewerId, mentions, uploads, socket, channel, thread, draft, onDraftChange, onSend, onSchedule }: {workspace?:string; sendDisabled?: boolean; sendDisabledReason?: string; suggestionRevision?: string; viewerId:string; onSend: ComponentProps<typeof ConversationComposer>['onSend']; onSchedule?: ComponentProps<typeof ConversationComposer>['controls']['onSchedule']; mentions: string[]; uploads: UploadDrafts; socket: Socket; channel: string; thread: string; draft?: RichDocument; onDraftChange: (document: RichDocument) => void }) {
  const loadReplySuggestion = useMemo(() => {
    if (suggestionRevision === undefined) return undefined;
    return async (signal: AbortSignal) => {
      const result = await request<{ suggestion: string | null }>(`/threads/${thread}/reply-suggestion`, {}, undefined, 'POST', signal);
      return result.suggestion;
    };
  }, [thread, suggestionRevision]);
  const findMentions = useMentionSearch(channel);
  const typing=useTypingPublisher(socket,channel,thread);
  const draftKey = `thread:${channel}:${thread}`;
  return <div onBlurCapture={typing.blur}><ConversationComposer workspace={workspace} conversationKey={draftKey} sendDisabled={sendDisabled} sendDisabledReason={sendDisabledReason} loadReplySuggestion={loadReplySuggestion} typingIndicator={<TypingIndicator channel={channel} thread={thread} viewerId={viewerId}/>} controls={{ findMentions, mentions, attachmentsEnabled: uploads.enabled, onSchedule }} attachments={uploads.drafts[draftKey] ?? []} onAttachmentsChange={files => uploads.change(draftKey, channel, files)} onRetryAttachment={id => uploads.retry(draftKey, channel, id)} channel="thread" scope="thread" draftValue={draft ?? null} acknowledgedDocument={uploads.acknowledged[draftKey]} onDraftChange={document=>{onDraftChange(document);typing.change(document);}} onSend={(text, document, files, options) => {
    const result = onSend(text, document, files, options);
    typing.stop();
    return result;
  }} /></div>;
}
