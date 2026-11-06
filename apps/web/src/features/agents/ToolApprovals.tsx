import {useEffect,useRef,useState} from 'react';
import type {LocalToolApproval,ToolApprovalDecision} from '@space/contracts';
import {Button} from '@space/ui/primitives';
import {request} from '../../shared/api/request.js';
import './tool-approvals.css';

export function ToolApprovals({items,canDecide,onResolved,audience}:{audience?:string;items:LocalToolApproval[];canDecide:boolean;onResolved:()=>void|Promise<void>}){
 const [busy,setBusy]=useState<string>(),[error,setError]=useState(''),[answered,setAnswered]=useState<Record<string,ToolApprovalDecision>>({});
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const pending=items.filter(item=>item.status==='pending'||((item.status==='allow'||item.status==='deny')&&!item.consumed_at));
 async function decide(item:LocalToolApproval,decision:ToolApprovalDecision){
  if(busy)return;setBusy(item.id);setError('');
  try{
   await request(`/agent-sessions/${item.session_id}/tool-approvals/${item.id}`,{decision});
   if(!alive.current)return;
   setAnswered(values=>({...values,[item.id]:decision}));await onResolved();
  }catch(reason){if(alive.current){setError(reason instanceof Error?reason.message.replaceAll('_',' '):'Could not send your decision.');await onResolved();}}
  finally{if(alive.current)setBusy(undefined);}
 }
 if(!pending.length&&!error)return null;
 return <section className="agent-tool-approvals" aria-label="Local access approvals">
  {error&&<p role="alert">{error}</p>}
  {pending.map(item=><article key={item.id} className="agent-tool-approval">
   <strong>{item.title}</strong><pre>{item.details}</pre>
   {item.kind==='project'&&<p>{audience??'People with access to this conversation'} can see file content and command output shared here.</p>}
   {item.status!=='pending'||answered[item.id]?<p role="status">{(answered[item.id]??item.status)==='allow'?'Allowed':'Denied'} — waiting for the agent to acknowledge.{canDecide&&<Button size="sm" variant="ghost" disabled={!!busy} onClick={()=>void decide(item,(answered[item.id]??item.status) as ToolApprovalDecision)}>Retry delivery</Button>}</p>:canDecide?<div className="agent-tool-approval-actions"><Button size="sm" disabled={!!busy} onClick={()=>void decide(item,'allow')}>Allow once</Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={()=>void decide(item,'deny')}>Deny</Button></div>:<p role="status">Waiting for the computer owner to approve.</p>}
  </article>)}
 </section>;
}
