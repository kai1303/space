import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChannelSummary } from '@space/contracts';
import { Button, LoadingStatus } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import type { Profile } from '../profile/profile-types.js';
import type { useAttachmentUploads } from '../composer/useAttachmentUploads.js';
import { ChannelRoom } from './ChannelRoom.js';

export function ThreadDestination({workspace, channel, thread, profile, attachments, onClose, detached}:{
  workspace:string; channel:string; thread:string; profile:Profile; attachments:ReturnType<typeof useAttachmentUploads>; onClose:()=>void; detached?:boolean;
}) {
  const [room,setRoom]=useState<ChannelSummary>(), [error,setError]=useState(''), [attempt,retry]=useState(0);
  const visibleThread = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    visibleThread.current = thread;
    return () => { visibleThread.current = undefined; };
  }, [thread]);
  useEffect(()=>{
    const controller=new AbortController();
    setRoom(undefined); setError('');
    void request<ChannelSummary>(`/channels/${encodeURIComponent(channel)}`,undefined,undefined,'POST',controller.signal,profile.id).then(value=>{
      if (value.workspace_id!==workspace || !value.joined) throw new Error('not_found');
      if (!controller.signal.aborted) setRoom(value);
    }).catch(()=>{if (!controller.signal.aborted) setError('This thread could not be opened.');});
    return ()=>controller.abort();
  },[workspace,channel,profile.id,attempt]);
  if (!room) return <div className="collection-loading">{error?<><p role="alert">{error}</p><Button onClick={()=>retry(n=>n+1)}>Retry</Button></>:<LoadingStatus>Opening thread…</LoadingStatus>} <Button variant="ghost" onClick={onClose}>Close thread</Button></div>;
  return <ChannelRoom key={thread} threadOnly={{close:onClose,detached}} requestedThread={thread} channel={room} profile={profile} uploads={attachments.uploads} drafts={attachments.draftState.current} onDraftChange={attachments.saveDraft} onChannelChange={setRoom} onAccessLost={()=>{attachments.forgetChannelDrafts(channel); setRoom(undefined); setError('This thread is no longer available.');}} onLeft={() => { if (visibleThread.current === thread) onClose(); }} searchOpen={false} onSearchClose={()=>{}} composeRequest={0} onMentionOpened={()=>{}}/>;
}
