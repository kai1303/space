import { Spinner } from '@space/ui/primitives';
import { ConversationMain, FrameHeader } from './ConversationFrame.js';
import { ConversationComposer } from './ThreadConversation.js';
export function ConversationLoadingStatus({ label }: { label: string }) {
  return <p className="chat-conversation-loading-status" role="status" aria-label={label}>
    <Spinner />{label}…
  </p>;
}

export function ConversationLoading({ label = 'Opening conversation', conversationKey }: { label?: string; conversationKey?: string }) {
  return <ConversationMain className="chat-channel" id="chat-messages" tabIndex={-1}>
    <FrameHeader primary><span>Conversation</span></FrameHeader>
    <div className="chat-channel-tabs" aria-hidden="true" />
    <div className="chat-timeline chat-timeline--virtual"><ConversationLoadingStatus label={label} /></div>
    <ConversationComposer primary inactive conversationKey={conversationKey ?? 'opening'} channel="conversation"
      placeholder="Write a message…" controls={{}} sendDisabled onSend={() => {}}/>
  </ConversationMain>;
}
