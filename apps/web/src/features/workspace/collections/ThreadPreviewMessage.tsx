import { useRef, useState } from 'react';
import type { HubThreadMessage } from '@space/contracts';
import { Avatar, IconButton, Menu } from '@space/ui/primitives';
import { EmojiPicker } from '@space/ui/emoji';
import { AgentMessageBody } from '../../agents/AgentMessageBody.js';
import { AssetAttachments } from '../../files/AssetAttachments.js';
import { ArrowSquareIn, BookmarkSimple, DotsThree, Smiley } from '@phosphor-icons/react';
import { request } from '../../../shared/api/request.js';

type Props = {onSource:()=>void; onUnread?:()=>Promise<void>; onUnfollow:()=>Promise<void>; name:string; date:string; text:string; message?:HubThreadMessage; viewer?:string; workspace:string; refresh:()=>Promise<void>};
export function ThreadPreviewMessage({name,date,text,message,workspace,viewer,refresh,onSource,onUnread,onUnfollow}:Props) {
  const [pending,setPending]=useState(false), [error,setError]=useState('');
  const writing=useRef(false);
  const run = async (action:()=>Promise<void>) => {
    if (writing.current) return;
    writing.current=true; setPending(true); setError('');
    try {await action();} catch {setError('Your change could not be saved. Try again.');}
    finally {writing.current=false; setPending(false);}
  };
  function mutate(path:string, body:object) {
    if (!viewer) return;
    void run(async () => {
      await request(path,body,undefined,'POST',undefined,viewer);
      await refresh();
    });
  }
  const react = (emoji:string) => message && mutate(`/channels/${message.channel_id}/messages/${message.id}/reactions`, {
    emoji, active:!message.reactions?.find(r=>r.emoji===emoji)?.user_ids.includes(viewer ?? ''),
  });
  const actions = !!viewer && message && !message.deleted_at && !message.encrypted;
  return <div className="thread-preview"><Avatar size="sm" name={name} initials={name.slice(0,2).toUpperCase()} image={message?.author.image}/><div className="thread-preview-copy">
    <strong>{name}</strong> <time dateTime={date} title={new Date(date).toLocaleString()}>{new Date(date).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}</time>
    {message?.deleted_at ? <p>Message deleted</p> : message?.encrypted ? <p>Encrypted message</p> : message ? <>
      <AgentMessageBody message={message} viewerId={viewer}/>
      {!!message.attachments?.length && <AssetAttachments assets={message.attachments}/>}
    </> : <p>{text || 'Shared a file'}</p>}
    {!!message?.reactions?.length && <div className="thread-preview-reactions">{message.reactions.map(r=><button key={r.emoji} disabled={!actions || pending} aria-pressed={r.user_ids.includes(viewer ?? '')} onClick={()=>react(r.emoji)}>{r.emoji} {r.count}</button>)}</div>}
    {error && <span role="alert">{error}</span>}
  </div>{actions && <div className="thread-preview-actions">
    <EmojiPicker label={'React to message from '+name} trigger={<Smiley size={16}/>} disabled={pending} onSelect={react}/>
    <IconButton label="Open in conversation" onClick={onSource}><ArrowSquareIn size={16}/></IconButton>
    <IconButton label={message.viewer_saved?'Remove saved message':'Save message for later'} disabled={pending} onClick={()=>void mutate(`/workspaces/${workspace}/hub/saved/${message.id}`,{channel_id:message.channel_id,active:!message.viewer_saved})}><BookmarkSimple weight={message.viewer_saved?'fill':'regular'} size={16}/></IconButton>
    <Menu floating label="More message actions" trigger={<DotsThree size={18}/>} items={[
      ...(onUnread ? [{label:'Mark unread',onSelect:()=>void run(onUnread)}] : []),
      {label:'Turn off notifications for this thread',onSelect:()=>void run(onUnfollow)},
    ]}/>
  </div>}</div>;
}
