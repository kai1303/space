import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MentionActivity, MentionNotification, MentionOption, MentionReference, MentionSettings } from '@space/contracts';
import { Avatar, Button, Dialog, IconButton } from '@space/ui/primitives';
import { type FindMentions } from '@space/ui/composer';
import { At } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import './mentions.css';
const failure=(error:unknown)=>error instanceof Error?error.message.replaceAll('_',' '):'Unable to load mentions';
export function useMentionSearch(channel:string):FindMentions {
  return useCallback(async query=>{ const result=await request<{items:MentionOption[];member_count:number}>(`/channels/${channel}/mentions?q=${encodeURIComponent(query)}`); if(!Array.isArray(result?.items)||!Number.isSafeInteger(result.member_count))throw new Error('Invalid mention directory response'); return result; },[channel]);
}
export function MentionDetails({channel,mention,onClose}:{channel:string;mention:MentionReference;onClose:()=>void}){
  const [data,setData]=useState<MentionOption&{full_name?:string;presence?:string;status?:{text:string;emoji:string}}>(),[error,setError]=useState('');
  useEffect(()=>{let active=true;void request<typeof data>(`/channels/${channel}/mentions/${mention.kind}/${mention.id}`).then(value=>{if(active)setData(value);}).catch(error=>{if(active)setError(failure(error));});return()=>{active=false;};},[channel,mention.kind,mention.id]);
  return <Dialog open title={data?.label??mention.label} onClose={onClose}><div className="space-mention-profile">{error?<p role="alert">{error}</p>:data?<><Avatar name={data.label} initials={data.label.slice(0,2).toUpperCase()}/><strong>{data.full_name||data.label}</strong><span>{data.detail||'Workspace member'}</span>{data.presence&&<span>{data.presence==='active'?'Active':'Away'}</span>}{data.status&&<p>{data.status.emoji} {data.status.text}</p>}{data.joined===false&&<p>Not a member of this channel.</p>}{data.kind==='agent'&&<p>Mentions request work through this channel’s existing agent permissions and approval flow.</p>}</>:<p role="status">Loading profile…</p>}</div></Dialog>;
}
export function MentionInbox({workspace,onOpen}:{workspace:string;onOpen:(item:MentionNotification)=>void}){
  const [open,setOpen]=useState(false),[activity,setActivity]=useState<MentionActivity>({items:[],unread_count:0,next_cursor:null}),[settings,setSettings]=useState<MentionSettings>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const epoch=useRef(0),revision=useRef(0);
  const refresh=useCallback(async()=>{
    const version=epoch.current,change=++revision.current;
    try {const [activity,settings]=await Promise.all([request<MentionActivity>(`/workspaces/${workspace}/mentions`),request<MentionSettings>(`/workspaces/${workspace}/mention-settings`)]);if(version!==epoch.current||change!==revision.current)return;if(!Array.isArray(activity?.items)||!Number.isSafeInteger(activity.unread_count)||!settings||!['all','admins'].includes(settings.broadcast_permission))throw new Error('Invalid mention activity response');setActivity(activity);setSettings(settings);setError('');}
    catch(error){if(version!==epoch.current||change!==revision.current)return;setActivity({items:[],unread_count:0,next_cursor:null});setSettings(undefined);setError(failure(error));}
  },[workspace]);
  useEffect(()=>{
    epoch.current++;setActivity({items:[],unread_count:0,next_cursor:null});setSettings(undefined);setOpen(false);setError('');
    const stop=subscribeUpdates('workspace',workspace,refresh,code=>{epoch.current++;setActivity({items:[],unread_count:0,next_cursor:null});setSettings(undefined);setError(failure(new Error(code)));});
    const changed=()=>{void refresh();};window.addEventListener('space:mentions-changed',changed);
    return()=>{epoch.current++;stop();window.removeEventListener('space:mentions-changed',changed);};
  },[workspace,refresh]);
  async function setting(patch:object){const version=epoch.current;setBusy(true);setError('');try{const updated=await request<MentionSettings>(`/workspaces/${workspace}/mention-settings`,patch,undefined,'PATCH');if(version===epoch.current){setSettings(updated);await refresh();}}catch(error){if(version===epoch.current)setError(failure(error));}finally{if(version===epoch.current)setBusy(false);}}
  async function visit(item:MentionNotification){const version=epoch.current;try{await request(`/workspaces/${workspace}/mentions/${item.id}/read`,{});if(version!==epoch.current)return;setOpen(false);onOpen(item);void refresh();}catch(error){if(version===epoch.current){setError(failure(error));void refresh();}}}
  async function older(){if(!activity.next_cursor)return;const version=epoch.current;setBusy(true);try{const next=await request<MentionActivity>(`/workspaces/${workspace}/mentions?before=${activity.next_cursor}`);if(version===epoch.current)setActivity(old=>({...next,items:[...old.items,...next.items]}));}catch(error){if(version===epoch.current)setError(failure(error));}finally{if(version===epoch.current)setBusy(false);}}
  const paused=Boolean(settings?.paused_until&&Date.parse(settings.paused_until)>Date.now());
  return <><div className="space-mentions-button"><IconButton label={`Mentions${activity.unread_count?` (${activity.unread_count} unread)`:''}`} onClick={()=>{setOpen(true);void refresh();}}><At size={22}/></IconButton>{activity.unread_count>0&&<span aria-hidden="true">{activity.unread_count>99?'99+':activity.unread_count}</span>}</div>
    <Dialog open={open} title="Mentions" onClose={()=>setOpen(false)}><div className="space-mentions-inbox">
      {error&&<p role="alert">{error}</p>}
      {settings&&<div className="space-mention-preferences"><p>{paused?'Mention attention is paused. New mentions appear here silently.':'People can get your attention by mentioning you.'}</p><Button size="sm" disabled={busy} onClick={()=>void setting({paused_until:paused?null:new Date(Date.now()+3600000).toISOString()})}>{paused?'Resume notifications':'Pause for 1 hour'}</Button>{settings.can_manage&&<label>Who can use channel-wide mentions<select disabled={busy} value={settings.broadcast_permission} onChange={e=>void setting({broadcast_permission:e.target.value})}><option value="all">All members</option><option value="admins">Owners and admins</option></select></label>}</div>}
      {!error&&!activity.items.length&&<p role="status">You’re all caught up. Mentions will appear here.</p>}
      <ul>{activity.items.map(item=><li key={item.id}><button type="button" className={!item.read_at&&!item.silent?'is-unread':''} onClick={()=>void visit(item)}><span><strong>{item.author_name}</strong><small>#{item.channel_name} · {new Date(item.created_at).toLocaleString()}{item.silent?' · Silent':''}</small></span><span>{item.text}</span></button></li>)}</ul>
      {activity.next_cursor&&<Button disabled={busy} onClick={()=>void older()}>Load older mentions</Button>}
    </div></Dialog>
  </>;
}
