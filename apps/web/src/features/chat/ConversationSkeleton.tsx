
export function ConversationSkeleton() {
  return <div className="chat-conversation-skeleton" aria-hidden="true">{[0, 1, 2].map(row => <div key={row}><i /><span><i /><i /><i /></span></div>)}</div>;
}
