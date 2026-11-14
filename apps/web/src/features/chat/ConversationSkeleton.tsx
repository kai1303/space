export function ConversationSkeleton({ label = 'Loading messages' }: { label?: string }) {
  return <>
    <p className="sp-sr-only" role="status" aria-label={label}>{label}…</p>
    <div className="chat-conversation-skeleton" aria-hidden="true">
      {[0, 1, 2].map(row => <div key={row}><i /><span><i /><i /><i /></span></div>)}
    </div>
  </>;
}
