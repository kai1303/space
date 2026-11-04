import type { SidekickContext } from '@space/contracts';
import './sidekick.css';

export function SidekickContextCard({ context }: { context: SidekickContext }) {
  return <details className="sidekick-context"><summary>{context.messages.length} messages from {context.channel_name}</summary><p>Private copy captured {new Date(context.captured_at).toLocaleString()}. File contents are not attached.</p>{context.messages.map(message=><article key={message.id}><strong>{message.author}</strong> <time>{new Date(message.created_at).toLocaleString()}</time><p>{message.text}</p>{message.files.length>0&&<small>Files mentioned: {message.files.join(', ')}</small>}</article>)}</details>;
}
