import { useMemberProfile } from '../profile/MemberProfile.js';
import type {ComponentProps,ReactNode} from 'react';
import type {ChatMessage,MentionReference} from '@space/contracts';
import { IconButton } from '@space/ui/primitives';
import { Message } from '@space/ui/conversation';
import { RichComposer } from '@space/ui/composer';
import {ArrowLeft,ChatCircle,X} from '@phosphor-icons/react';
import {AgentMessageBody} from '../agents/AgentMessageBody.js';
import {AssetAttachments} from '../files/AssetAttachments.js';

export function ConversationHeader({title,channel,icon=<ChatCircle size={20}/>,status,actions,onBack,onClose,backLabel='Back to thread',heading,topic}: {
 title:string;channel?:string;icon?:ReactNode;status?:string;actions?:ReactNode;onBack?:()=>void;onClose?:()=>void;backLabel?:string;heading?:ReactNode;topic?:ReactNode;
}) {
 return <header className="chat-channel-header">{heading??<div className="chat-thread-title">{icon}<h2>{title}</h2>{channel&&<span>#{channel}</span>}{status&&<span role="status" className="chat-thread-status">{status}</span>}</div>}{topic}<div className="chat-header-actions">{onBack&&<IconButton label={backLabel} onClick={onBack}><ArrowLeft size={20}/></IconButton>}{actions}{onClose&&<IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}><X size={20}/></IconButton>}</div></header>;
}
export function ConversationNavigation({children}:{children:ReactNode}) {
 return <div className="chat-channel-tabs"><span><ChatCircle size={15}/> Messages</span>{children}</div>;
}
export function ConversationIntroduction({title,icon,children}:{title:string;icon:ReactNode;children:ReactNode}) {
 return <div className="chat-channel-welcome dm-conversation-intro"><div className="chat-empty-icon">{icon}</div><h2>{title}</h2><p>{children}</p></div>;
}
export function ConversationComposer({typingIndicator,onBlurCapture,...props}:ComponentProps<typeof RichComposer>&{typingIndicator?:ReactNode;onBlurCapture?:ComponentProps<'div'>['onBlurCapture']}) {
 return <div className="chat-compose" onBlurCapture={onBlurCapture}>{typingIndicator}<RichComposer showKeyboardHint={false} feedbackAtSendButton {...props}/></div>;
}
type MessageIdentity = Pick<ChatMessage,'author'|'created_at'>;
export function continuesMessageGroup(message:MessageIdentity,previous?:MessageIdentity) {
 if(message.author.kind === 'workflow' || !previous || message.author.id!==previous.author.id || message.author.kind!==previous.author.kind) return false;
 const current=new Date(message.created_at), prior=new Date(previous.created_at), elapsed=current.getTime()-prior.getTime();
 // Five minutes is Space's grouping window; Slack's exact cutoff wasn't observable.
 return elapsed>=0 && elapsed<5*60*1000 && current.toDateString()===prior.toDateString();
}
export function ConversationMessage({message,previous,viewerId,arrival,onReact,onReply,replyCount,actions,footer,onMentionClick,streaming,showAgentActivity,body,children}: {
 previous?:MessageIdentity;
 message:ChatMessage;viewerId:string;arrival?:boolean;onReact?:(emoji:string)=>void;onReply?:()=>void;replyCount?:number;
 actions?:ComponentProps<typeof Message>['actions'];footer?:ReactNode;onMentionClick?:(mention:MentionReference)=>void;streaming?:boolean;showAgentActivity?:boolean;body?:ReactNode;children?:ReactNode;
}) {
 const profiles = useMemberProfile();
 const deleted = !!message.deleted_at;
 const openMention = (mention:MentionReference) => { if(profiles && mention.kind !== 'broadcast') profiles.open({kind:mention.kind,id:mention.id}); else onMentionClick?.(mention); };
 return <Message workflow={message.author.kind === 'workflow'} app={message.author.kind === 'app'} onAuthorClick={profiles && message.author.kind !== 'app' && message.author.kind !== 'workflow' ? () => profiles.open({kind:message.author.kind === 'agent' ? 'agent' : 'user',id:message.author.id}) : undefined} grouped={continuesMessageGroup(message,previous)} author={message.author.name} initials={message.author.name.slice(0,2).toUpperCase()} agent={message.author.kind==='agent'} tone={message.author.kind==='agent'?'green':message.author.id===viewerId?'blue':'purple'} arrival={arrival} time={new Date(message.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} reactions={deleted ? [] : (message.reactions??[]).map(reaction=>({emoji:reaction.emoji,count:reaction.count,active:reaction.user_ids.includes(viewerId)}))} onReact={deleted ? undefined : onReact} onReply={onReply} replyCount={replyCount??message.reply_count} actions={deleted ? undefined : actions} footer={footer}>
  {deleted ? <em className="chat-deleted-message">This message was deleted.</em> : <>{body??<><AgentMessageBody message={message} viewerId={viewerId} onMentionClick={openMention} streaming={streaming} newArrival={arrival} showActivity={showAgentActivity}/>{!!message.attachments?.length&&<AssetAttachments assets={message.attachments}/>}</>}{children}</>}
 </Message>;
}
export function ConversationReplyDivider({count}:{count:number}) {
 return count>0?<div className="chat-reply-divider" role="separator" aria-label={`${count} ${count===1?'reply':'replies'}`}>{count} {count===1?'reply':'replies'}</div>:null;
}
