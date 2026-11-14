import { useEffect, useRef, useState, type FormEvent } from 'react';
import { sessionPath, type AgentSessionSummary, type AgentSessionTurn, type NavigatorCandidate, type SessionRelatedAgent, type WorkspaceProfile } from '@space/contracts';
import { Button, Select } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';

type Props = { session:AgentSessionSummary; channel:string; viewer:string; writable:boolean; turns:AgentSessionTurn[]; related:SessionRelatedAgent[]; refresh:()=>Promise<void> };
export function SessionAgentHandoff({session,channel,viewer,writable,turns,related,refresh}:Props) {
  const [open,setOpen]=useState(false), [choices,setChoices]=useState<NavigatorCandidate[]>([]);
  const [selected,setSelected]=useState(''), [owner,setOwner]=useState(''), [prompt,setPrompt]=useState(''), [context,setContext]=useState('');
  const [loading,setLoading]=useState(true), [sending,setSending]=useState(false), [error,setError]=useState(''), [opened,setOpened]=useState('');
  const attempt=useRef<{body:string;key:string} | undefined>(undefined), pending=useRef(false);
  const candidate=choices.find(item => item.installation_id+'|'+item.skill===selected);
  useEffect(() => {
    if (!open || !writable) return;
    const controller=new AbortController();
    setLoading(true);setError('');
    void request<{candidates:NavigatorCandidate[]}>(`/channels/${channel}/navigator`,undefined,undefined,'POST',controller.signal,viewer)
      .then(data => {if(!controller.signal.aborted) setChoices(data.candidates.filter(item=>item.persistent_sessions && item.installation_id!==session.installation_id));})
      .catch(() => {if(!controller.signal.aborted)setError('Could not load agents. Reopen the form to retry.');})
      .finally(() => {if(!controller.signal.aborted)setLoading(false);});
    return () => controller.abort();
  },[channel,open,writable,session.installation_id,viewer]);
  useEffect(()=>{
    if (!candidate) return;
    const controller=new AbortController();setOwner('');
    void request<WorkspaceProfile>(`/workspaces/${session.workspace_id}/profiles/agent/${candidate.installation_id}`,undefined,undefined,'POST',controller.signal,viewer)
      .then(profile=>{if(!controller.signal.aborted && profile.kind==='agent')setOwner(profile.owner_name);})
      .catch(()=>{if(!controller.signal.aborted)setError('Could not load the agent owner. Select the agent again.');});
    return ()=>controller.abort();
  },[candidate?.installation_id,session.workspace_id,viewer]);
  async function invite(event:FormEvent) {
    event.preventDefault();if(!candidate||!owner||!prompt.trim()||pending.current)return;
    const payload={installation_id:candidate.installation_id,skill:candidate.skill,prompt:prompt.trim(),...(context.trim()?{context:context.trim()}:{})};
    const body=JSON.stringify(payload);
    if(attempt.current?.body!==body)attempt.current={body,key:crypto.randomUUID()};
    pending.current=true;setSending(true);setError('');
    try{
      const result=await request<{id:string}>(`/agent-sessions/${session.id}/team/helpers`,payload,attempt.current.key,'POST',undefined,viewer);
      attempt.current=undefined;setOpened(result.id);setPrompt('');setContext('');setOpen(false);await refresh();
    }catch(cause){setError(cause instanceof Error ? cause.message.replaceAll('_',' ') : 'Could not send the request.');}
    finally{pending.current=false;setSending(false);}
  }
  const excerpts=turns.slice(-20).flatMap(turn=>{
    const reply=turn.response?.messages.filter(message=>message.status==='complete' && message.phase!=='commentary').map(message=>message.text).join('\n') || turn.task.result;
    return [turn.task.goal,reply].flatMap((text,index)=>text?.trim()?[{id:turn.task.id+':'+index,text:text.slice(0,1800)}]:[]);
  });
  return <section className="session-helper-agents" aria-label="Collaborating agents">
    {related.length>0&&<ul>{related.map(item=><li key={item.id}><a href={sessionPath(item.id)}>{item.title}</a><small>{item.relation==='parent'?'From':'Helper'} · {item.agent_name} · {item.owner_name}</small></li>)}</ul>}
    {opened && !related.some(item=>item.id===opened) && <a href={sessionPath(opened)}>Open helper session</a>}
    {writable && !open && <Button size="sm" onClick={()=>setOpen(true)}>Ask another agent</Button>}
    {error && <p role="alert">{error}</p>}
    {open && writable && <form onSubmit={invite}>
      <label>Agent<Select aria-label="Agent" value={selected} disabled={sending} onChange={event=>{if (event.target.value.split('|')[0]!==candidate?.installation_id) setOwner('');setError('');setSelected(event.target.value);}}>
        <option value="">{loading?'Loading agents…':choices.length?'Choose an agent':'No other eligible agents'}</option>
        {choices.map(item=><option value={item.installation_id+'|'+item.skill} key={item.installation_id+'|'+item.skill}>{item.name} · {item.skill}</option>)}
      </Select></label>
      {owner && <small>Agent owner · {owner}</small>}
      <label>Request<textarea value={prompt} required disabled={sending} maxLength={2000} onChange={event=>setPrompt(event.target.value)}/></label>
      {excerpts.length>0 && <label>Copy a message into context<Select aria-label="Copy a message into context" disabled={sending} value="" onChange={event=>{const item=excerpts.find(value=>value.id===event.target.value);if(item)setContext(item.text);}}>
        <option value="">Choose a message</option>{excerpts.map(item=><option key={item.id} value={item.id}>{item.text.slice(0,90)}</option>)}
      </Select></label>}
      <label>Context to share<textarea value={context} disabled={sending} maxLength={1800} onChange={event=>setContext(event.target.value)}/></label>
      <Button type="submit" size="sm" disabled={sending||!candidate||!owner||!prompt.trim()}>Start linked session</Button>
      <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={()=>setOpen(false)}>Cancel</Button>
    </form>}
  </section>;
}
