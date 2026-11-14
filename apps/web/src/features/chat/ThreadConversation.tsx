import { FrameComposer, FrameHeader } from './ConversationFrame.js';
import { useMemberProfile } from '../profile/MemberProfile.js';
import { AttachFileDialog, workspaceFileSource, type FilePickerSource } from '../files/AttachFileDialog.js';
import {useMemo,type ComponentProps,type ReactNode} from 'react';
import type {ChatMessage,ManagedChannelTab,MentionReference} from '@space/contracts';
import { IconButton, Tabs } from '@space/ui/primitives';
import { Message } from '@space/ui/conversation';
import { RichComposer } from '@space/ui/composer';
import {ArrowLeft,CaretLeft,ChatCircle,X} from '@phosphor-icons/react';
import { usePhoneLayout } from '../../shared/ui/conversation-list.js';
import {channelTabIcons,channelTabNames} from '../channels/ChannelTabs.js';
import {AgentMessageBody} from '../agents/AgentMessageBody.js';
import {AssetAttachments} from '../files/AssetAttachments.js';

export function ConversationHeader({primary, title,channel,icon=<ChatCircle size={20}/>,status,actions,onBack,onClose,closeBackLabel,backLabel='Back to thread',heading,topic}: {
 primary?:boolean;title:string;channel?:string;icon?:ReactNode;status?:string;actions?:ReactNode;onBack?:()=>void;onClose?:()=>void;backLabel?:string;closeBackLabel?:string;heading?:ReactNode;topic?:ReactNode;
}) {
 // Phones: panels open full screen, so closing reads as going back, with Slack's back arrow on the left.
 // One back per screen: the nearer step (onBack) wins over closing the panel.
 const phone = usePhoneLayout();
 const step = !phone ? null : onBack ? { label: backLabel, go: onBack } : onClose ? { label: closeBackLabel ?? (channel ? `Back to #${channel}` : `Close ${title.toLowerCase()}`), go: onClose } : null;
 const back = step && <IconButton className="chat-conversation-back" label={step.label} onClick={step.go}><CaretLeft size={20} weight="bold"/></IconButton>;
 if (step) { onBack = undefined; onClose = undefined; }
 return <FrameHeader primary={primary}>{back}{heading??<div className="chat-thread-title">{icon}<h2>{title}</h2>{channel&&<span>#{channel}</span>}{status&&<span role="status" className="chat-thread-status">{status}</span>}</div>}{topic}<div className="chat-header-actions">{onBack&&<IconButton label={backLabel} onClick={onBack}><ArrowLeft size={20}/></IconButton>}{actions}{onClose&&<IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}><X size={20}/></IconButton>}</div></FrameHeader>;
}
export function ConversationNavigation({children, order, view, onChange, onReorder}: {
  children: ReactNode; order: readonly ManagedChannelTab[]; view: string; onChange: (id: string) => void;
  onReorder?: (tab:string,target:string,side:'before'|'after')=>void;
}) {
  const items = [{id:'messages', label:'Messages', icon:<ChatCircle size={15}/>, fixed:true},
    ...order.map(id => {
      const Icon = channelTabIcons[id];
      return {id,label:channelTabNames[id],icon:<Icon size={15}/>,panelId:id === 'files' ? 'channel-shared-content' : id === 'memory' ? 'channel-memory' : undefined,
        opensDialog:id === 'navigator'};
    })];
  return <div className="chat-channel-tabs"><Tabs label="Channel views" items={items} value={view} onChange={onChange} onReorder={onReorder}/>{children}</div>;
}
export function ConversationIntroduction({title,icon,children}:{title:string;icon:ReactNode;children:ReactNode}) {
 return <div className="chat-channel-welcome dm-conversation-intro"><div className="chat-empty-icon">{icon}</div><h2>{title}</h2><p>{children}</p></div>;
}
type RichComposerProps = ComponentProps<typeof RichComposer>;
export type ComposerControls = Pick<RichComposerProps,
  | 'formattingEnabled' | 'emojiEnabled' | 'attachmentsEnabled' | 'audioClipsEnabled' | 'videoClipsEnabled'
  | 'findMentions' | 'mentions' | 'onSchedule' | 'renderAddMenuItems'
  | 'renderBeforeSend' | 'renderExtraActions' | 'submitAccessory'
>;
type ConversationComposerProps = Omit<RichComposerProps, keyof ComposerControls | 'showUnavailableActions' | 'attachedFormattingToolbar' | 'addMenuVariant'> & {
  primary?: boolean;
  inactive?: boolean;
  controls: ComposerControls;
  workspace?: string;
  filePickerSource?: FilePickerSource;
  typingIndicator?: ReactNode;
  onBlurCapture?: ComponentProps<'div'>['onBlurCapture'];
};

export function ConversationComposer({ primary, inactive, controls, typingIndicator, onBlurCapture, workspace, filePickerSource, ...props }: ConversationComposerProps) {
  const source = useMemo(() => filePickerSource ?? (workspace ? workspaceFileSource(workspace) : undefined), [workspace, filePickerSource]);
  const composer = <div className="chat-compose" inert={inactive} onBlurCapture={onBlurCapture}>
    {typingIndicator}
    <RichComposer {...props} attachmentsEnabled={false} {...controls} addMenuVariant="agent-session"
      showKeyboardHint={false} feedbackAtSendButton showUnavailableActions={false}
      renderFilePicker={source && ((onInsert, onClose, remaining, onUpload) =>
        <AttachFileDialog source={source} onUpload={onUpload} remaining={remaining} onInsert={onInsert} onClose={onClose}/>)}/>
  </div>;
  return primary ? <FrameComposer>{composer}</FrameComposer> : composer;
}
type MessageIdentity = Pick<ChatMessage,'author'|'created_at'>;
export function continuesMessageGroup(message:MessageIdentity,previous?:MessageIdentity) {
 if(message.author.kind === 'workflow' || !previous || message.author.id!==previous.author.id || message.author.kind!==previous.author.kind) return false;
 const current=new Date(message.created_at), prior=new Date(previous.created_at), elapsed=current.getTime()-prior.getTime();
 // Five minutes is Space's grouping window; Slack's exact cutoff wasn't observable.
 return elapsed>=0 && elapsed<5*60*1000 && current.toDateString()===prior.toDateString();
}
export function ConversationMessage({message,previous,viewerId,arrival,animateActions,onReact,onReply,replyCount,hasReplyDraft,threadOpen,actions,footer,onMentionClick,streaming,showAgentActivity,body,children}: {
 previous?:MessageIdentity;
 message:ChatMessage;viewerId:string;arrival?:boolean;animateActions?:boolean;onReact?:(emoji:string)=>void;onReply?:()=>void;replyCount?:number;hasReplyDraft?:boolean;threadOpen?:boolean;
 actions?:ComponentProps<typeof Message>['actions'];footer?:ReactNode;onMentionClick?:(mention:MentionReference)=>void;streaming?:boolean;showAgentActivity?:boolean;body?:ReactNode;children?:ReactNode;
}) {
 const profiles = useMemberProfile();
 const deleted = !!message.deleted_at;
 const openMention = (mention:MentionReference) => { if(profiles && mention.kind !== 'broadcast') profiles.open({kind:mention.kind,id:mention.id}); else onMentionClick?.(mention); };
 return <Message animateActions={animateActions} workflow={message.author.kind === 'workflow'} app={message.author.kind === 'app'} onAuthorClick={profiles && message.author.kind !== 'app' && message.author.kind !== 'workflow' ? () => profiles.open({kind:message.author.kind === 'agent' ? 'agent' : 'user',id:message.author.id}) : undefined} grouped={continuesMessageGroup(message,previous)} author={message.author.name} initials={message.author.name.slice(0,2).toUpperCase()} agent={message.author.kind==='agent'} tone={message.author.kind==='agent'?'green':message.author.id===viewerId?'blue':'purple'} arrival={arrival} time={new Date(message.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} reactions={deleted ? [] : (message.reactions??[]).map(reaction=>({emoji:reaction.emoji,count:reaction.count,active:reaction.user_ids.includes(viewerId)}))} onReact={deleted ? undefined : onReact} onReply={onReply} replyCount={replyCount??message.reply_summary?.count??message.reply_count}
    replyParticipants={message.reply_summary?.participants} participantCount={message.reply_summary?.participant_count}
    lastReplyAt={message.reply_summary?.last_reply_at} hasReplyDraft={hasReplyDraft} threadOpen={threadOpen} actions={deleted ? undefined : actions} footer={footer}>
  {deleted ? <em className="chat-deleted-message">This message was deleted.</em> : <>{body??<><AgentMessageBody message={message} viewerId={viewerId} onMentionClick={openMention} streaming={streaming} newArrival={arrival} showActivity={showAgentActivity}/>{!!message.attachments?.length&&<AssetAttachments assets={message.attachments}/>}</>}{children}</>}
 </Message>;
}
export function ConversationReplyDivider({count}:{count:number}) {
 return count>0?<div className="chat-reply-divider" role="separator" aria-label={`${count} ${count===1?'reply':'replies'}`}>{count} {count===1?'reply':'replies'}</div>:null;
}
