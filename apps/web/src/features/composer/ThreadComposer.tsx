import { ConversationComposer } from '../chat/ThreadConversation.js';
import { TypingIndicator, useTypingPublisher } from '../chat/typing.js';
import { useMentionSearch } from "../mentions/Mentions.js";
import { request } from '../../shared/api/request.js';
import { useMemo, useState, type ComponentProps } from 'react';
import type { Socket } from 'socket.io-client';
import { type RichDocument } from '@space/ui/rich-text';
import { type UploadDrafts } from './useAttachmentUploads.js';

export function ThreadComposer({ onEditReady, editorLabel, workspace, broadcastDestination, sendDisabled, sendDisabledReason, suggestionRevision, viewerId, mentions, uploads, socket, channel, thread, draft, onDraftChange, onSend, onSchedule }: {onEditReady?:()=>void;editorLabel?:string; workspace?:string; broadcastDestination?:string; sendDisabled?: boolean; sendDisabledReason?: string; suggestionRevision?: string; viewerId:string; onSend: (...args: [...Parameters<ComponentProps<typeof ConversationComposer>['onSend']>, alsoSendToChannel?: boolean]) => ReturnType<ComponentProps<typeof ConversationComposer>['onSend']>; onSchedule?: (...args: [...Parameters<NonNullable<ComponentProps<typeof ConversationComposer>['controls']['onSchedule']>>, alsoSendToChannel?: boolean]) => Promise<void>; mentions: string[]; uploads: UploadDrafts; socket: Socket; channel: string; thread: string; draft?: RichDocument; onDraftChange: (document: RichDocument) => void }) {
  const [alsoSend, setAlsoSend] = useState(false);
  const broadcast = !!broadcastDestination && alsoSend;
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
  return <div onBlurCapture={typing.blur}><ConversationComposer onEditReady={onEditReady} editorLabel={editorLabel} workspace={workspace} conversationKey={draftKey} sendDisabled={sendDisabled} sendDisabledReason={sendDisabledReason} loadReplySuggestion={loadReplySuggestion} typingIndicator={<TypingIndicator channel={channel} thread={thread} viewerId={viewerId}/>} controls={{ findMentions, mentions, attachmentsEnabled: uploads.enabled, onSchedule: onSchedule && (async (text, document, files, at) => { await onSchedule(text, document, files, at, broadcast); setAlsoSend(false); }) }} attachments={uploads.drafts[draftKey] ?? []} onAttachmentsChange={files => uploads.change(draftKey, channel, files)} onRetryAttachment={id => uploads.retry(draftKey, channel, id)} channel="thread" scope="thread" placeholder="Reply…" draftValue={draft ?? null} acknowledgedDocument={uploads.acknowledged[draftKey]} onDraftChange={document=>{onDraftChange(document);typing.change(document);}} onSend={async (text, document, files, options) => {
    const result = await onSend(text, document, files, options, broadcast);
    setAlsoSend(false); typing.stop();
    return result;
  }} />{broadcastDestination && <label className="thread-broadcast-option"><input type="checkbox" checked={alsoSend}
    onChange={event => setAlsoSend(event.target.checked)} /> Also send to {broadcastDestination}</label>}</div>;
}
