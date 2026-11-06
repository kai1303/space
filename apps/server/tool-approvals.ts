import type {FastifyInstance} from 'fastify';
import type {Server} from 'socket.io';
import {AppError,record,uuid} from '@space/contracts';
import type {AgentConnectionStore} from '@space/postgres/agent-connections';
import type {ToolApprovalStore} from '@space/postgres/tool-approvals';
import type {RealtimeWork} from './realtime-work.js';

export function registerToolApprovals(app:FastifyInstance,io:Server,store:ToolApprovalStore,connections:AgentConnectionStore,
 work:RealtimeWork,onOutbox:(listener:(keys?:readonly string[])=>void)=>()=>void,invalidate:(keys?:readonly string[])=>void){
 const agents=io.of('/agents');
 const delivering=new Set<string>();
 const retries=new Map<string,ReturnType<typeof setTimeout>>();
 let closed=false;
 async function deliver(id:string,attempt=0){
  if(closed||delivering.has(id))return;
  if(delivering.size>=128){
   if(!retries.has(id)&&retries.size<512&&attempt<5)retries.set(id,setTimeout(()=>{retries.delete(id);void deliver(id,attempt+1).catch(()=>{});},250*2**attempt));
   throw new AppError(503,'approval_delivery_busy');
  }
  delivering.add(id);
  try{
   const decision=await store.decision(id);
   if(decision)agents.to(`connection:${decision.connection_id}`).emit('agent.tool.decision',{
    id:decision.id,task_id:decision.task_id,execution_id:decision.execution_id,decision:decision.status,
   });
  }finally{delivering.delete(id);}
 }
 const unsubscribe=onOutbox(keys=>{for(const key of keys??[])if(key.startsWith('tool-approval:'))void deliver(key.slice(14)).catch(()=>{});});
 app.addHook('onClose',async()=>{closed=true;unsubscribe();for(const timer of retries.values())clearTimeout(timer);retries.clear();});
 app.post<{Params:{sessionId:string;approvalId:string}}>('/v1/agent-sessions/:sessionId/tool-approvals/:approvalId',async request=>{
  const id=uuid(request.params.approvalId);
  const result=await store.decide(request.actorId,uuid(request.params.sessionId),id,request.body);
  await deliver(id);
  return result;
 });
 agents.on('connection',socket=>{
  const identity=socket.data.agent as {id:string;connection_id:string};
  void socket.join(`connection:${identity.connection_id}`);
  let pending=0;
  for(const operation of ['request','consume'] as const)socket.on(`agent.tool.${operation}`,(raw:unknown,ack:unknown)=>{
   if(typeof ack!=='function')return;
   if(pending>=8){ack({error:'busy'});return;}
   pending++;
   void work.run(socket.id,async()=>{
    try{
     await connections.authenticateConnection(socket.data.token,identity.connection_id);
     if(!socket.connected)throw new AppError(401,'unauthorized');
     const input=record(raw,operation==='request'?['task_id','execution_id','approval']:['id']);
     const data=operation==='request'
      ?await store.request(identity.id,identity.connection_id,uuid(input.task_id),uuid(input.execution_id),input.approval)
      :await store.consume(identity.id,identity.connection_id,uuid(input.id));
     ack({data});
     // Local direct turns also refresh immediately when the broker is unavailable.
     const {rows}=operation==='request'
      ?await store.pool.query('SELECT thread_id FROM tasks WHERE id=$1',[input.task_id])
      :await store.pool.query('SELECT t.thread_id FROM agent_tool_approvals a JOIN tasks t ON t.id=a.task_id WHERE a.id=$1',[input.id]);
     if(rows[0])invalidate([`thread:${rows[0].thread_id}`]);
    }catch(error){ack({error:error instanceof AppError?error.code:'internal_error'});}
   }).catch(()=>ack({error:'internal_error'})).finally(()=>pending--);
  });
 });
}
