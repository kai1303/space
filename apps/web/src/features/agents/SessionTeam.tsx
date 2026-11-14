import { useEffect, useRef, useState } from 'react';
import { Button, toast } from '@space/ui/primitives';
import type { AgentSessionOutputs, SessionTeamView, SharedSessionOutput, WorkspaceDirectory } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates, invalidateUpdates } from '../../shared/realtime/live-updates.js';
import { TaskChanges, TaskFiles, TaskPreview } from './AgentTaskWorkspace.js';
import { PublishedCodeView } from './CodeChannelArtifacts.js';
import './session-team.css';

type Props = { id:string; viewer:string; outputs?:AgentSessionOutputs; standalone?:boolean };
type Run = (operation:()=>Promise<void>)=>Promise<void>;

export function SessionTeam({id,viewer,outputs,standalone}:Props) {
  const base = `/agent-sessions/${id}/team`;
  const [team,setTeam] = useState<SessionTeamView>();
  const [error,setError] = useState(''), [pending,setPending] = useState(false);
  const [text,setText] = useState(''), [before,setBefore] = useState('');
  const attempt = useRef<{body:string;key:string} | undefined>(undefined);
  const sending = useRef(false);
  const [retry,setRetry] = useState(0);
  useEffect(()=>{
    let alive=true;
    const controller = new AbortController();
    const unavailable = () => {
      if (!alive) return;
      alive=false; controller.abort(); setTeam(undefined); setText(''); setError('This review room is unavailable.');
    };
    const stop=subscribeUpdates('session-team',id,async()=>{
      try {
        const page = await request<SessionTeamView>(base+(before?'?before='+before:''),undefined,undefined,undefined,controller.signal,viewer);
        if (alive) { setTeam(page); setError(''); }
      } catch (cause) {
        if (['forbidden','unauthorized','not_found','actor_changed'].includes((cause as Error).message)) unavailable();
        else if (alive) {setTeam(undefined);setError('Could not load the review room.');}
      }
    },unavailable);
    return ()=>{alive=false;controller.abort();stop();};
  },[base,id,viewer,before,retry]);

  const run:Run = async operation => {
    if(sending.current) return;
    sending.current=true;setPending(true);setError('');
    try {
      await operation();
      await invalidateUpdates('session-team',id);
    } catch (cause) {
      const reason=(cause as Error).message;
      if (['forbidden','unauthorized','not_found','actor_changed'].includes(reason)) {setTeam(undefined);setError('This action is unavailable. Refresh the review room.');}
      else setError(reason==='session_output_changed'?'This output changed. Review the updated version before sharing.':reason==='session_read_only'?'This session is read-only.':'Could not save. Please try again.');
    } finally {sending.current=false;setPending(false);}
  };
  async function post(body:string,key:string) {
    await request(base+'/discussion',{text:body},key,'POST',undefined,viewer);
    setBefore('');
    await invalidateUpdates('session-team',id);
  }
  async function submit() {
    if (!text.trim()) return;
    const body=text;
    if (attempt.current?.body!==body) attempt.current={body,key:crypto.randomUUID()};
    const key=attempt.current.key;
    await run(async()=>{await post(body,key);setText(current=>current===body?'':current);attempt.current=undefined;});
  }
  return <section className={'session-team'+(standalone?' session-team-page':'')} aria-label="Session team">
    {standalone && <header><a href="/chat">Space</a><h1>{team?.title || 'Session review'}</h1></header>}
    {error && <p role="alert">{error} <Button size="sm" onClick={()=>setRetry(n=>n+1)}>Refresh</Button></p>}
    {!team && !error && <p role="status">Opening team discussion…</p>}
    {team && <>
      <details className="session-team-section"><summary>People and access {team.reviewers.length || ''}</summary>
        <p>{team.workspace_visible?'All full workspace members can open this review room.':'Only source conversation members and invited reviewers can open this room.'}</p>
        {team.can_manage && (team.writable || team.workspace_visible) && <label>
          <input type="checkbox" checked={team.workspace_visible} disabled={pending} onChange={e=>{const value=e.target.checked;void run(async()=>{await request(base+'/visibility',{workspace_visible:value},undefined,'PUT',undefined,viewer);});}}/> Make discussion and shared snapshots visible to workspace members
        </label>}
        {team.reviewers.map(person=><div className="session-team-row" key={person.user_id}><span>{person.display_name}</span>
          {(team.can_manage || person.user_id===viewer) && <Button size="sm" variant="ghost" disabled={pending} onClick={()=>void run(async()=>{
            await request(base+'/reviewers/'+person.user_id,undefined,undefined,'DELETE',undefined,viewer);
            toast.success(team.can_manage ? 'Reviewer invitation removed' : 'You left the review');
          })}>{team.can_manage?'Remove invitation':'Leave review'}</Button>}</div>)}
        {team.can_manage && team.writable && <InviteReviewer team={team} invite={user=>run(async()=>{await request(base+'/reviewers/'+user,{},undefined,'PUT',undefined,viewer);})} pending={pending}/>}
        <a href={'/review/'+id}>Open review room</a>
      </details>
      {outputs && team.can_manage && <ShareOutputs available={outputs} shared={team.shared} pending={pending} writable={team.writable} change={(item,remove)=>run(async()=>{await request(base+'/shared',{kind:item.kind,path:item.path,output:remove?null:item.output},undefined,'PUT',undefined,viewer);})}/>}
      {team.shared.length>0 && <SharedArtifacts items={team.shared} post={team.writable?post:undefined}/>}
      <h3>Team discussion</h3>
      {team.before && <Button size="sm" variant="ghost" onClick={()=>{setTeam(undefined);setBefore(team.before!);}}>Earlier comments</Button>}
      {before && <Button size="sm" variant="ghost" onClick={()=>{setTeam(undefined);setBefore('');}}>Latest comments</Button>}
      {team.messages.length===0 && <p>Discuss the work with your teammates here.</p>}
      <ol aria-label="Discussion comments">{team.messages.map(message=><li key={message.sequence}><strong>{message.author}</strong> <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time><p>{message.body}</p></li>)}</ol>
      {team.writable && <form onSubmit={e=>{e.preventDefault();void submit();}}><textarea value={text} maxLength={4000} rows={3} onChange={e=>setText(e.target.value)} aria-label="Message the team" placeholder="Message the team…"/><Button type="submit" disabled={pending||!text.trim()}>Send comment</Button></form>}
    </>}
  </section>;
}

function SharedArtifacts({items,post}:{items:SharedSessionOutput[];post?: (text:string,key:string)=>Promise<void>}) {
  const files=items.flatMap(item=>item.kind==='file'?[item.output]:[]);
  const changes=items.flatMap(item=>item.kind==='change'?[item.output]:[]);
  const preview=items.find(item=>item.kind==='preview');
  const views=items.flatMap(item=>item.kind==='view'?[item.output]:[]);
  return <div className="session-team-section"><h3>Shared for review</h3>
    {changes.length>0 && <details><summary>Changes {changes.length}</summary><TaskChanges changes={changes} onReview={post}/></details>}
    {files.length>0 && <details><summary>Files {files.length}</summary><TaskFiles files={files}/></details>}
    {preview && <details><summary>{preview.output.label}</summary><TaskPreview preview={preview.output}/></details>}
    {views.map(view=><details key={view.key}><summary>{view.name}</summary><PublishedCodeView view={view}/></details>)}
  </div>;
}

function InviteReviewer({team,invite,pending}:{team:SessionTeamView;invite:(id:string)=>Promise<void>;pending:boolean}) {
  const [q,setQ]=useState(''),[members,setMembers]=useState<WorkspaceDirectory['items']>([]),[error,setError]=useState('');
  useEffect(()=>{
    setMembers([]);setError('');
    if(!q.trim())return;
    const controller=new AbortController(),timer=setTimeout(()=>{
      const params=new URLSearchParams({q:q.trim(),limit:'12',guest:'none',sort:'name'});
      void request<WorkspaceDirectory>(`/workspaces/${team.workspace_id}/directory?${params}`,undefined,undefined,undefined,controller.signal,team.viewer_id)
        .then(result=>{if(!controller.signal.aborted)setMembers(result.items);})
        .catch(()=>{if(!controller.signal.aborted)setError('Could not find teammates.');});
    },180);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[q,team.workspace_id,team.viewer_id]);
  return <div><label>Invite a reviewer<input type="search" value={q} maxLength={100} placeholder="Search teammates" onChange={e=>setQ(e.target.value)}/></label>
    <small>Invitees can read this discussion and the outputs you share here.</small>{error && <p role="alert">{error}</p>}
    {members.filter(member=>member.user_id!==team.viewer_id&&!team.reviewers.some(p=>p.user_id===member.user_id)).map(member=><div className="session-team-row" key={member.user_id}>{member.display_name}<Button size="sm" disabled={pending} onClick={()=>void invite(member.user_id)}>Invite</Button></div>)}
  </div>;
}

function ShareOutputs({available,shared,pending,writable,change}:{available:AgentSessionOutputs;shared:SharedSessionOutput[];pending:boolean;writable:boolean;change:(item:SharedSessionOutput,remove:boolean)=>Promise<void>}) {
  const all:SharedSessionOutput[]=[
    ...available.files.map(output=>({kind:'file' as const,path:output.path,output})),
    ...available.changes.map(output=>({kind:'change' as const,path:output.path,output})),
    ...(available.preview?[{kind:'preview' as const,path:'' as const,output:available.preview}]:[]),
    ...(available.views??[]).map(output=>({kind:'view' as const,path:output.key,output})),
  ];
  return <details className="session-team-section"><summary>Manage shared outputs</summary>
    {all.length===0 && <p>No outputs are available yet.</p>}
    {writable && all.map(item=><div className="session-team-row" key={item.kind+':'+item.path}><span>{item.kind} · {item.kind==='view' ? item.output.name : item.path || 'Preview'}</span><Button disabled={pending} size="sm" onClick={()=>void change(item,false)}>{shared.some(s=>s.kind===item.kind&&s.path===item.path)?'Update snapshot':'Share snapshot'}</Button></div>)}
    {shared.map(item=><div className="session-team-row" key={item.kind+':'+item.path}><span>{item.kind==='view' ? item.output.name : item.path || 'Preview'}</span><Button disabled={pending} size="sm" variant="ghost" onClick={()=>void change(item,true)}>Stop sharing</Button></div>)}
  </details>;
}
