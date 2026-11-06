import {CODING_TURN_TIMEOUT_MS,parseLocalToolApproval,type ToolApprovalDecision} from '@space/contracts';
import type {RuntimeControls} from './agent-runtime.js';

type Run={task_id:string;execution_id:string};
type Wire={on(name:string,handler:(value:any)=>void):unknown;off(name:string,handler:(value:any)=>void):unknown};
type Pending={run:Run;settle(value:ToolApprovalDecision):Promise<void>;reject(error:Error):void};
export function toolApprovalClient(socket:Wire,rpc:(name:string,payload:unknown,shouldSend?:()=>boolean)=>Promise<unknown>){
 const pending=new Map<string,Pending>();
 const receive=(value:any)=>{
  const item=pending.get(value?.id);
  if(!item || value.task_id!==item.run.task_id || value.execution_id!==item.run.execution_id || !['allow','deny'].includes(value.decision))return;
  void item.settle(value.decision).catch(item.reject);
 };
 socket.on('agent.tool.decision',receive);
 const cancel=()=>{for(const item of [...pending.values()])item.reject(new Error('Approval connection closed.'));};
 socket.on('disconnect',cancel);
 return {
  controls(run:Run):RuntimeControls{return {requestApproval(raw,signal){
   signal.throwIfAborted();const input=parseLocalToolApproval(raw);
   if(pending.size>=32||pending.has(input.id))return Promise.reject(new Error('Too many pending approvals.'));
   return new Promise<ToolApprovalDecision>((resolve,reject)=>{
    let resolving=false;
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);pending.delete(input.id);};
    const fail=(error:Error)=>{cleanup();reject(error);};
    const abort=()=>fail(signal.reason instanceof Error?signal.reason:new Error('Approval cancelled.'));
    const timer=setTimeout(()=>fail(new Error('Approval timed out.')),CODING_TURN_TIMEOUT_MS);
    const item:Pending={run,reject:fail,async settle(decision){
     if(resolving||!pending.has(input.id))return;resolving=true;
     signal.throwIfAborted();
     const confirmed=await rpc('agent.tool.consume',{id:input.id},()=>!signal.aborted);
     signal.throwIfAborted();
     if(confirmed!==decision)throw new Error('Approval changed before execution.');
     cleanup();resolve(decision);
    }};
    pending.set(input.id,item);signal.addEventListener('abort',abort,{once:true});
    void rpc('agent.tool.request',{task_id:run.task_id,execution_id:run.execution_id,approval:input},()=>!signal.aborted).then(async result=>{
     if(signal.aborted)return;
     const status=(result as {status?:unknown})?.status;
     if(status==='allow'||status==='deny')await item.settle(status);
     else if(status!=='pending')throw new Error('Approval request was rejected.');
    }).catch(fail);
   });
  }};},
  close(){cancel();socket.off('agent.tool.decision',receive);socket.off('disconnect',cancel);},
 };
}
