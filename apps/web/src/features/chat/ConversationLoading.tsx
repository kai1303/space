export function ConversationLoadingStatus({ label }: { label: string }) {
  return <p className="chat-conversation-loading-status" role="status" aria-label={label}>
    <span className="sp-spinner" aria-hidden="true" />{label}…
  </p>;
}

export function ConversationLoading({ label = 'Opening conversation' }: { label?: string }) {
  return <main className="chat-channel" id="chat-messages" tabIndex={-1}>
    <div className="chat-channel-header" aria-hidden="true"><span className="chat-loading-title" /></div>
    <div className="chat-channel-tabs" aria-hidden="true" />
    <div className="chat-timeline chat-timeline--virtual"><ConversationLoadingStatus label={label} /></div>
    <div className="chat-compose" aria-hidden="true"><div className="sp-rich-editor-shell chat-loading-editor"><div className="sp-rich-toolbar" /></div></div>
  </main>;
}
