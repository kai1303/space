import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MentionActivity, MentionNotification, MentionOption, MentionReference, MentionSettings } from '@space/contracts';
import { Select, Avatar, Button, Dialog, IconButton, LoadingStatus, ListRowSkeleton } from '@space/ui/primitives';
import { type FindMentions } from '@space/ui/composer';
import { At } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import './mentions.css';
const failure=(error:unknown)=>error instanceof Error?error.message.replaceAll('_',' '):'Unable to load mentions';
const denied=(error:unknown)=>error instanceof Error && ['unauthorized','forbidden','not_found','actor_changed'].includes(error.message);
export function useMentionSearch(channel:string):FindMentions {
  return useCallback(async query=>{ const result=await request<{items:MentionOption[];member_count:number}>(`/channels/${channel}/mentions?q=${encodeURIComponent(query)}`); if(!Array.isArray(result?.items)||!Number.isSafeInteger(result.member_count))throw new Error('Invalid mention directory response'); return result; },[channel]);
}
export function MentionDetails({channel,mention,onClose}:{channel:string;mention:MentionReference;onClose:()=>void}){
  const [data,setData]=useState<MentionOption&{full_name?:string;presence?:string;status?:{text:string;emoji:string}}>(),[error,setError]=useState('');
  useEffect(()=>{let active=true;setData(undefined);setError('');void request<typeof data>(`/channels/${channel}/mentions/${mention.kind}/${mention.id}`).then(value=>{if(active)setData(value);}).catch(error=>{if(active)setError(failure(error));});return()=>{active=false;};},[channel,mention.kind,mention.id]);
  return <Dialog open title={data?.label??mention.label} onClose={onClose}><div className="space-mention-profile">{error?<p role="alert">{error}</p>:data?<><Avatar name={data.label} initials={data.label.slice(0,2).toUpperCase()}/><strong>{data.full_name||data.label}</strong><span>{data.detail||'Workspace member'}</span>{data.presence&&<span>{data.presence==='active'?'Active':'Away'}</span>}{data.status&&<p>{data.status.emoji} {data.status.text}</p>}{data.joined===false&&<p>Not a member of this channel.</p>}{data.kind==='agent'&&<p>Mentions request work through this channel’s existing agent permissions and approval flow.</p>}</>:<LoadingStatus>Loading profile…</LoadingStatus>}</div></Dialog>;
}
export function MentionInbox({workspace,onOpen}:{workspace:string;onOpen:(item:MentionNotification)=>void}){
  const [open,setOpen]=useState(false),[activity,setActivity]=useState<MentionActivity>(),[settings,setSettings]=useState<MentionSettings>(),[error,setError]=useState('');
  const [saving,setSaving]=useState<'pause'|'permission'>(),[paging,setPaging]=useState(false);
  const [revoked,setRevoked]=useState(false);
  const [activityError,setActivityError]=useState(''),[settingsError,setSettingsError]=useState('');
  const epoch=useRef(0),revision=useRef(0), settingsRevision=useRef(0);
  const refresh=useCallback(async()=>{
    const version=epoch.current,change=++revision.current,settingsRead=++settingsRevision.current;
    const current=()=>version===epoch.current && change===revision.current;
    await Promise.all([
      request<MentionActivity>(`/workspaces/${workspace}/mentions`).then(value=>{
        if(!Array.isArray(value?.items)||!Number.isSafeInteger(value.unread_count))throw new Error('Invalid mention activity response');
        if(current()){setActivity(value);setActivityError('');}
      }).catch(reason=>{if(current()){if(denied(reason))setActivity(undefined);setActivityError(failure(reason));}}),
      request<MentionSettings>(`/workspaces/${workspace}/mention-settings`).then(value=>{
        if(!value || !['all','admins'].includes(value.broadcast_permission))throw new Error('Invalid mention settings response');
        if(current() && settingsRead===settingsRevision.current){setSettings(value);setSettingsError('');}
      }).catch(reason=>{if(current() && settingsRead===settingsRevision.current){if(denied(reason))setSettings(undefined);setSettingsError(failure(reason));}}),
    ]);
  },[workspace]);
  useEffect(()=>{
    epoch.current++;setRevoked(false);setSaving(undefined);setPaging(false);setActivity(undefined);setSettings(undefined);setActivityError('');setSettingsError('');setOpen(false);setError('');
    let active=true;
    const stop=subscribeUpdates('workspace',workspace,refresh,code=>{active=false;epoch.current++;setRevoked(true);setSaving(undefined);setPaging(false);setActivity(undefined);setSettings(undefined);setActivityError('');setSettingsError('');setError(failure(new Error(code)));});
    const changed=()=>{if(active)void refresh();};window.addEventListener('space:mentions-changed',changed);
    return()=>{epoch.current++;stop();window.removeEventListener('space:mentions-changed',changed);};
  },[workspace,refresh]);
  async function setting(patch:Partial<Pick<MentionSettings,'paused_until'|'broadcast_permission'>>) {
    if(saving || revoked)return;
    const version=epoch.current;
    setSaving('paused_until' in patch?'pause':'permission');setError('');
    try {
      const updated=await request<MentionSettings>(`/workspaces/${workspace}/mention-settings`,patch,undefined,'PATCH');
      if(version===epoch.current){settingsRevision.current++;setSettings(updated);setSettingsError('');}
    }catch(reason){if(version===epoch.current)setError(failure(reason));}
    finally{if(version===epoch.current)setSaving(undefined);}
  }
  async function visit(item:MentionNotification){const version=epoch.current;try{await request(`/workspaces/${workspace}/mentions/${item.id}/read`,{});if(version!==epoch.current)return;setOpen(false);onOpen(item);void refresh();}catch(error){if(version===epoch.current){setError(failure(error));void refresh();}}}
  async function older() {
    if(!activity?.next_cursor || paging || revoked)return;
    const version=epoch.current,cursor=activity.next_cursor,read=revision.current;
    setPaging(true);setError('');
    try {
      const next=await request<MentionActivity>(`/workspaces/${workspace}/mentions?before=${encodeURIComponent(cursor)}`);
      if(version===epoch.current && read===revision.current)setActivity(old=>{
        if(!old || old.next_cursor!==cursor)return old;
        const ids=new Set(old.items.map(item=>item.id));
        return {...old,next_cursor:next.next_cursor,items:[...old.items,...next.items.filter(item=>!ids.has(item.id))]};
      });
    }catch(reason){
      if(version===epoch.current && read===revision.current){
        if(denied(reason)){setActivity(undefined);setActivityError(failure(reason));}
        else setError(failure(reason));
      }
    }
    finally{if(version===epoch.current)setPaging(false);}
  }
  const paused=Boolean(settings?.paused_until&&Date.parse(settings.paused_until)>Date.now());
  return <><div className="space-mentions-button"><IconButton label={`Mentions${activity?.unread_count?` (${activity.unread_count} unread)`:''}`} onClick={()=>{setOpen(true);if(!revoked && (activity || settings || activityError || settingsError))void refresh();}}><At size={22}/></IconButton>{!!activity?.unread_count&&<span aria-hidden="true">{activity.unread_count>99?'99+':activity.unread_count}</span>}</div>
    <Dialog open={open} title="Mentions" onClose={()=>setOpen(false)}><div className="space-mentions-inbox">
      {(error || activityError || settingsError) && <p role="alert">{[...new Set([error,activityError,settingsError].filter(Boolean))].join(' · ')} {(activityError || settingsError) && !revoked && <Button size="sm" onClick={()=>{setActivityError('');setSettingsError('');void refresh();}}>Retry</Button>}</p>}
      {!settings && !settingsError && !revoked && <LoadingStatus>Loading mention preferences…</LoadingStatus>}
      {settings&&<div className="space-mention-preferences"><p>{paused?'Mention attention is paused. New mentions appear here silently.':'People can get your attention by mentioning you.'}</p><Button size="sm" loading={saving==='pause'} disabled={!!saving} onClick={()=>void setting({paused_until:paused?null:new Date(Date.now()+3600000).toISOString()})}>{paused?'Resume notifications':'Pause for 1 hour'}</Button>{settings.can_manage&&<label>Who can use channel-wide mentions<Select aria-label="Who can use channel-wide mentions" disabled={!!saving} aria-busy={saving==='permission' || undefined} value={settings.broadcast_permission} onChange={e=>void setting({broadcast_permission:e.target.value==='admins'?'admins':'all'})}><option value="all">All members</option><option value="admins">Owners and admins</option></Select></label>}</div>}
      {!activity && !activityError && !revoked && <ListRowSkeleton label="Loading mentions…"/>}
      {activity&&!activity.items.length&&<p role="status">You’re all caught up. Mentions will appear here.</p>}
      <ul>{activity?.items.map(item=><li key={item.id}><button type="button" className={!item.read_at?'is-unread':''} onClick={()=>void visit(item)}><span><strong>{item.author_name}</strong><small>#{item.channel_name} · {new Date(item.created_at).toLocaleString()}{item.silent?' · Silent':''}</small></span><span>{item.text}</span></button></li>)}</ul>
      {activity?.next_cursor&&<Button loading={paging} onClick={()=>void older()}>Load older mentions</Button>}
    </div></Dialog>
  </>;
}
