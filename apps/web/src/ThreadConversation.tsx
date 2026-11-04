import type {ComponentProps,ReactNode} from 'react';
import type {ChatMessage,MentionReference} from '@space/contracts';
import {IconButton,Message,RichComposer} from '@space/ui';
import {ArrowLeft,ChatCircle,X} from '@phosphor-icons/react';
import {AgentMessageBody} from './AgentMessageBody.js';
import {AssetAttachments} from './AssetAttachments.js';

export function ConversationHeader({title,channel,icon=<ChatCircle size={20}/>,status,actions,onBack,onClose}: {
 title:string;channel?:string;icon?:ReactNode;status?:string;actions?:ReactNode;onBack?:()=>void;onClose?:()=>void;
}) {
 return <header className="chat-channel-header"><div className="chat-thread-title">{icon}<h2>{title}</h2>{channel&&<span>#{channel}</span>}{status&&<span role="status" className="chat-thread-status">{status}</span>}</div><div className="chat-header-actions">{onBack&&<IconButton label="Back to thread" onClick={onBack}><ArrowLeft size={20}/></IconButton>}{actions}{onClose&&<IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}><X size={20}/></IconButton>}</div></header>;
}
export function ConversationComposer({typingIndicator,...props}:ComponentProps<typeof RichComposer>&{typingIndicator?:ReactNode}) {
 return <div className="chat-compose">{typingIndicator}<RichComposer {...props}/></div>;
}
export function ConversationMessage({message,viewerId,arrival,onReact,onReply,replyCount,actions,footer,onMentionClick,streaming,body,children}: {
 message:ChatMessage;viewerId:string;arrival?:boolean;onReact?:(emoji:string)=>void;onReply?:()=>void;replyCount?:number;
 actions?:ComponentProps<typeof Message>['actions'];footer?:ReactNode;onMentionClick?:(mention:MentionReference)=>void;streaming?:boolean;body?:ReactNode;children?:ReactNode;
}) {
 return <Message author={message.author.name} initials={message.author.name.slice(0,2).toUpperCase()} agent={message.author.kind==='agent'} tone={message.author.kind==='agent'?'green':message.author.id===viewerId?'blue':'purple'} arrival={arrival} time={new Date(message.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} reactions={(message.reactions??[]).map(reaction=>({emoji:reaction.emoji,count:reaction.count,active:reaction.user_ids.includes(viewerId)}))} onReact={onReact} onReply={onReply} replyCount={replyCount??message.reply_count} actions={actions} footer={footer}>
  {body??<><AgentMessageBody message={message} viewerId={viewerId} onMentionClick={onMentionClick} streaming={streaming}/>{!!message.attachments?.length&&<AssetAttachments assets={message.attachments}/>}</>}{children}
 </Message>;
}
export function ConversationReplyDivider({count}:{count:number}) {
 return count>0?<div className="chat-reply-divider" role="separator" aria-label={`${count} ${count===1?'reply':'replies'}`}>{count} {count===1?'reply':'replies'}</div>:null;
}
