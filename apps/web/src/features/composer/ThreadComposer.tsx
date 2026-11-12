import { ConversationComposer } from '../chat/ThreadConversation.js';
import { TypingIndicator, useTypingPublisher } from '../chat/typing.js';
import { useMentionSearch } from "../mentions/Mentions.js";
import { request } from '../../shared/api/request.js';
import { useMemo, type ComponentProps } from 'react';
import type { Socket } from 'socket.io-client';
import { type RichDocument } from '@space/ui/rich-text';
import { type UploadDrafts } from './useAttachmentUploads.js';

export function ThreadComposer({ sendDisabled, sendDisabledReason, suggestionRevision, showUnavailableActions = true, viewerId, mentions, uploads, socket, channel, thread, draft, onDraftChange, onSend, onSchedule }: {sendDisabled?: boolean; sendDisabledReason?: string; suggestionRevision?: string; showUnavailableActions?:boolean; viewerId:string; onSend: ComponentProps<typeof ConversationComposer>['onSend']; onSchedule?: ComponentProps<typeof ConversationComposer>['onSchedule']; mentions: string[]; uploads: UploadDrafts; socket: Socket; channel: string; thread: string; draft?: RichDocument; onDraftChange: (document: RichDocument) => void }) {
  const loadReplySuggestion = useMemo(() => {
    if (suggestionRevision === undefined) return undefined;
    return async (signal: AbortSignal) => {
      const result = await request<{ suggestion: string | null }>(`/threads/${thread}/reply-suggestion`, {}, undefined, 'POST', signal);
      return result.suggestion;
    };
  }, [thread, suggestionRevision]);
  const findMentions = useMentionSearch(channel);
  const typing=useTypingPublisher(socket,channel,thread);
  return <div onBlurCapture={typing.blur}><ConversationComposer sendDisabled={sendDisabled} sendDisabledReason={sendDisabledReason} loadReplySuggestion={loadReplySuggestion} showUnavailableActions={showUnavailableActions} typingIndicator={<TypingIndicator channel={channel} thread={thread} viewerId={viewerId}/>} findMentions={findMentions} mentions={mentions} attachmentsEnabled={uploads.enabled} attachments={uploads.drafts[`thread:${channel}:${thread}`] ?? []} onAttachmentsChange={files => uploads.change(`thread:${channel}:${thread}`, channel, files)} onRetryAttachment={id => uploads.retry(`thread:${channel}:${thread}`, channel, id)} channel="thread" scope="thread" onSchedule={onSchedule} defaultValue={draft} acknowledgedDocument={uploads.acknowledged[`thread:${channel}:${thread}`]} onDraftChange={document=>{onDraftChange(document);typing.change(document);}} onSend={(text, document, files, options) => {
    const result = onSend(text, document, files, options);
    typing.stop();
    return result;
  }} /></div>;
}
