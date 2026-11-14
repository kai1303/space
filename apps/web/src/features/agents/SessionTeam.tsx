import { RichContent } from '@space/ui/rich-text';
import { useEffect, useRef, useState } from 'react';
import { Button, LoadingStatus, toast } from '@space/ui/primitives';
import type { AgentSessionOutputs, SessionTeamView, SharedSessionOutput, WorkspaceDirectory } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates, invalidateUpdates } from '../../shared/realtime/live-updates.js';
import { TaskChanges, TaskFiles, TaskPreview } from './AgentTaskWorkspace.js';
import { PublishedCodeView } from './CodeChannelArtifacts.js';
import './session-team.css';

type Props = { id:string; viewer:string; outputs?:AgentSessionOutputs; standalone?:boolean };
type Run = (key:string, operation:()=>Promise<void>)=>Promise<void>;

export function SessionTeam(props:Props) {
  return <ReviewRoom key={props.id+':'+props.viewer} {...props}/>;
}

function ReviewRoom({id,viewer,outputs,standalone}:Props) {
  const base = `/agent-sessions/${id}/team`;
  const [team,setTeam] = useState<SessionTeamView>();
  const [shownCursor,setShownCursor] = useState('');
  const [readError,setReadError] = useState(''), [unavailable,setUnavailable] = useState(false);
  const [error,setError] = useState(''), [pending,setPending] = useState<ReadonlySet<string>>(new Set());
  const [text,setText] = useState(''), [before,setBefore] = useState('');
  const attempt = useRef<{body:string;key:string} | undefined>(undefined);
  const sending = useRef(new Set<string>());
  const readController = useRef<AbortController | null>(null);
  const [retry,setRetry] = useState(0);
  useEffect(()=>{
    const controller = new AbortController();
    readController.current = controller;
    setReadError('');
    const loseAccess = () => {
      if (controller.signal.aborted) return;
      controller.abort(); setUnavailable(true); setTeam(undefined); setText(''); attempt.current=undefined; setReadError('This review room is unavailable.');
    };
    const stop=subscribeUpdates('session-team',id,async()=>{
      try {
        const page = await request<SessionTeamView>(base+(before?'?before='+before:''),undefined,undefined,undefined,controller.signal,viewer);
        if (!controller.signal.aborted) { setUnavailable(false); setTeam(page); setShownCursor(before); setReadError(''); }
      } catch (cause) {
        if (['forbidden','unauthorized','not_found','actor_changed'].includes((cause as Error).message)) loseAccess();
        else if (!controller.signal.aborted) setReadError('Could not load the review room.');
      }
    },loseAccess);
    return ()=>{controller.abort();stop();};
  },[base,id,viewer,before,retry]);

  const run:Run = async (key,operation) => {
    if(sending.current.has(key)) return;
    sending.current.add(key);setPending(new Set(sending.current));setError('');
    try {
      await operation();
      await invalidateUpdates('session-team',id);
    } catch (cause) {
      const reason=(cause as Error).message;
      if (['forbidden','unauthorized','not_found','actor_changed'].includes(reason)) {readController.current?.abort();setUnavailable(true);setTeam(undefined);setText('');attempt.current=undefined;setError('This action is unavailable. Refresh the review room.');}
      else setError(reason==='session_output_changed'?'This output changed. Review the updated version before sharing.':reason==='session_read_only'?'This session is read-only.':'Could not save. Please try again.');
    } finally {sending.current.delete(key);setPending(new Set(sending.current));}
  };
  async function post(body:string,key:string) {
    await request(base+'/discussion',{text:body},key,'POST',undefined,viewer);
    setBefore('');
    await invalidateUpdates('session-team',id);
  }
  async function submit() {
    if (!team?.writable || sending.current.has('comment') || !text.trim()) return;
    const body=text;
    if (attempt.current?.body!==body) attempt.current={body,key:crypto.randomUUID()};
    const key=attempt.current.key;
    await run('comment',async()=>{await request(base+'/discussion',{text:body},key,'POST',undefined,viewer);setBefore('');setText(current=>current===body?'':current);attempt.current=undefined;});
  }
  const paging = !!team && shownCursor !== before && !readError;
  function go(cursor:string) {
    if (cursor === before) setRetry(n=>n+1);
    else setBefore(cursor);
  }
  const inviteReviewer=(user:string)=>run('reviewer:'+user,async()=>{
    await request(base+'/reviewers/'+user,{},undefined,'PUT',undefined,viewer);
    toast.success('Reviewer invited');
  });
  return <section className={'session-team'+(standalone?' session-team-page':'')} aria-label="Session team">
    {standalone && <header><a href="/chat">Space</a><h1>{team?.title || 'Session review'}</h1></header>}
    {(readError || error) && <p role="alert">{readError || error} <Button size="sm" onClick={()=>{setError('');setRetry(n=>n+1);}}>Refresh</Button></p>}
    {team && <>
      <details className="session-team-section"><summary>People and access {team.reviewers.length || ''}</summary>
        <p>{team.workspace_visible?'All full workspace members can open this review room.':'Only source conversation members and invited reviewers can open this room.'}</p>
        {team.can_manage && (team.writable || team.workspace_visible) && <label>
          <input type="checkbox" checked={team.workspace_visible} disabled={pending.has('visibility')} onChange={e=>{const value=e.target.checked;void run('visibility',async()=>{await request(base+'/visibility',{workspace_visible:value},undefined,'PUT',undefined,viewer);});}}/> Make discussion and shared snapshots visible to workspace members
        </label>}
        {team.reviewers.map(person=><div className="session-team-row" key={person.user_id}><span>{person.display_name}</span>
          {(team.can_manage || person.user_id===viewer) && <Button size="sm" variant="ghost" loading={pending.has('reviewer:'+person.user_id)} onClick={()=>void run('reviewer:'+person.user_id,async()=>{
            await request(base+'/reviewers/'+person.user_id,undefined,undefined,'DELETE',undefined,viewer);
            toast.success(team.can_manage ? 'Reviewer invitation removed' : 'You left the review');
          })}>{team.can_manage?'Remove invitation':'Leave review'}</Button>}</div>)}
        {team.can_manage && team.writable && <InviteReviewer team={team} invite={inviteReviewer} pending={pending}/>}
        <a href={'/review/'+id}>Open review room</a>
      </details>
      {outputs && team.can_manage && <ShareOutputs available={outputs} shared={team.shared} pending={pending} writable={team.writable} change={(item,remove)=>run('snapshot:'+item.kind+':'+item.path,async()=>{await request(base+'/shared',{kind:item.kind,path:item.path,output:remove?null:item.output},undefined,'PUT',undefined,viewer);})}/>}
      {team.shared.length>0 && <SharedArtifacts items={team.shared} post={team.writable?post:undefined}/>}
    </>}
    {!standalone && !team && !readError && <LoadingStatus>Loading reviewers…</LoadingStatus>}
    {standalone && <><h3>Team discussion</h3>
    {!team && !readError && !error && <LoadingStatus>Opening team discussion…</LoadingStatus>}
    {team && <>
      {team.before && <Button size="sm" variant="ghost" loading={paging && !!before} onClick={()=>go(team.before!)}>Earlier comments</Button>}
      {(before || shownCursor) && <Button size="sm" variant="ghost" loading={paging && !before} onClick={()=>go('')}>Latest comments</Button>}
      {!paging && team.messages.length===0 && <p>Discuss the work with your teammates here.</p>}
      <ol aria-label="Discussion comments">{team.messages.map(message=><li key={message.sequence}><strong>{message.author}</strong> <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time><div>{message.document?<RichContent document={message.document} viewerId={viewer}/>:message.body}</div></li>)}</ol>
    </>}
    {(team?.writable || (!team && !unavailable)) && <form onSubmit={e=>{e.preventDefault();void submit();}}><textarea value={text} maxLength={4000} rows={3} onChange={e=>setText(e.target.value)} aria-label="Message the team" placeholder="Message the team…"/><Button type="submit" loading={pending.has('comment')} disabled={!team?.writable||!text.trim()}>Send comment</Button></form>}</>}
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

function InviteReviewer({team,invite,pending}:{team:SessionTeamView;invite:(id:string)=>Promise<void>;pending:ReadonlySet<string>}) {
  const [q,setQ]=useState(''), [page,setPage]=useState<{query:string;items:WorkspaceDirectory['items']}>(), [error,setError]=useState('');
  const [retry,setRetry]=useState(0), [pendingSearch,setPendingSearch]=useState(false);
  const query=q.trim();
  useEffect(()=>{
    if(!query)return;
    setPendingSearch(true);
    const controller=new AbortController(),timer=setTimeout(()=>{
      const params=new URLSearchParams({q:query,limit:'12',guest:'none',sort:'name'});
      void request<WorkspaceDirectory>(`/workspaces/${team.workspace_id}/directory?${params}`,undefined,undefined,undefined,controller.signal,team.viewer_id)
        .then(result=>{if(!controller.signal.aborted)setPage({query,items:result.items});})
        .catch(()=>{if(!controller.signal.aborted){setPage(undefined);setError('Could not find teammates.');}})
        .finally(()=>{if(!controller.signal.aborted)setPendingSearch(false);});
    },180);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[query,team.workspace_id,team.viewer_id,retry]);
  const searching=!!query && (pendingSearch || page?.query!==query) && !error;
  const candidates=query ? page?.items.filter(member=>member.user_id!==team.viewer_id &&
    !team.reviewers.some(p=>p.user_id===member.user_id) && (!searching || member.display_name.toLowerCase().includes(query.toLowerCase()))) ?? [] : [];
  return <div><label>Invite a reviewer<input type="search" value={q} maxLength={100} placeholder="Search teammates" onChange={e=>{setQ(e.target.value);if(e.target.value.trim()!==query)setError('');}}/></label>
    <small>Invitees can read the team discussion and explicitly shared outputs.</small>
    {error && <p role="alert">{error} <Button size="sm" onClick={()=>{setError('');setRetry(n=>n+1);}}>Retry search</Button></p>}
    {searching && <LoadingStatus>Searching teammates…</LoadingStatus>}
    {candidates.map(member=><div className="session-team-row" key={member.user_id}>{member.display_name}<Button size="sm" loading={pending.has('reviewer:'+member.user_id)} onClick={()=>void invite(member.user_id)}>Invite</Button></div>)}
    {query && !searching && !error && !candidates.length && <p>No matching teammates to invite.</p>}
  </div>;
}

function ShareOutputs({available,shared,pending,writable,change}:{available:AgentSessionOutputs;shared:SharedSessionOutput[];pending:ReadonlySet<string>;writable:boolean;change:(item:SharedSessionOutput,remove:boolean)=>Promise<void>}) {
  const all:SharedSessionOutput[]=[
    ...available.files.map(output=>({kind:'file' as const,path:output.path,output})),
    ...available.changes.map(output=>({kind:'change' as const,path:output.path,output})),
    ...(available.preview?[{kind:'preview' as const,path:'' as const,output:available.preview}]:[]),
    ...(available.views??[]).map(output=>({kind:'view' as const,path:output.key,output})),
  ];
  return <details className="session-team-section"><summary>Manage shared outputs</summary>
    {all.length===0 && <p>No outputs are available yet.</p>}
    {writable && all.map(item=><div className="session-team-row" key={item.kind+':'+item.path}><span>{item.kind} · {item.kind==='view' ? item.output.name : item.path || 'Preview'}</span><Button disabled={pending.has('snapshot:'+item.kind+':'+item.path)} size="sm" onClick={()=>void change(item,false)}>{shared.some(s=>s.kind===item.kind&&s.path===item.path)?'Update snapshot':'Share snapshot'}</Button></div>)}
    {shared.map(item=><div className="session-team-row" key={item.kind+':'+item.path}><span>{item.kind==='view' ? item.output.name : item.path || 'Preview'}</span><Button disabled={pending.has('snapshot:'+item.kind+':'+item.path)} size="sm" variant="ghost" onClick={()=>void change(item,true)}>Stop sharing</Button></div>)}
  </details>;
}
