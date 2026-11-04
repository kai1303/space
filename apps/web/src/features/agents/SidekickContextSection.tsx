import type { SidekickContext } from '@space/contracts';
import { useId } from 'react';
import { Message } from '@space/ui/conversation';
import { Paperclip } from '@phosphor-icons/react';
import './sidekick.css';

export function SidekickContextSection({ context }: { context: SidekickContext }) {
  const titleId=useId();
  const source=context.channel_name==='Direct conversation'?context.channel_name:`#${context.channel_name.replace(/^#/,'')}`;
  return <section className="sidekick-context-section" aria-labelledby={titleId}>
    <header className="sidekick-context-heading"><h3 id={titleId}>Selected messages</h3><span>{source}</span></header>
    {context.messages.map(message=><Message key={message.id} author={message.author} initials={message.author.slice(0,2).toUpperCase()} time={new Date(message.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}>
      <span>{message.text}</span>
      {message.files.length>0&&<div className="sidekick-context-files"><Paperclip size={14}/><span>{message.files.join(', ')}</span><small>Names only</small></div>}
    </Message>)}
  </section>;
}
