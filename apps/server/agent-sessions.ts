import type { FastifyInstance } from 'fastify';
import { AppError, record, text, uuid, type Task } from '@space/contracts';
import type { AgentSessionStore } from '@space/postgres/agent-sessions';
export function registerAgentSessionRoutes(app: FastifyInstance, sessions: AgentSessionStore, accepted?: (task:Task)=>Promise<void>, stopped?: (session:string)=>Promise<void>, steer?: (connection:string,input:{session_id:string;execution_id:string;id:string;text:string})=>Promise<void>) {
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/agent-sessions', request => sessions.listWorkspace(request.actorId, uuid(request.params.workspaceId), request.query));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/sidekick-agents', request => sessions.sidekicks.agents(request.actorId, uuid(request.params.workspaceId)));
  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/sidekick-sessions', request => sessions.sidekicks.list(request.actorId, uuid(request.params.workspaceId), request.query));
  app.post<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId/sidekick-sessions', async (request, reply) => reply.code(201).send(await sessions.sidekicks.create(request.actorId, uuid(request.params.workspaceId), request.body)));
  app.get<{ Params: { threadId: string } }>('/v1/threads/:threadId/agent-sessions', request => sessions.list(request.actorId, uuid(request.params.threadId)));
  app.post<{ Params: { threadId: string } }>('/v1/threads/:threadId/agent-sessions', async (request, reply) => reply.code(201).send(await sessions.create(request.actorId, uuid(request.params.threadId), request.body)));
  app.get<{ Params: { sessionId: string } }>('/v1/agent-sessions/:sessionId/location', request => sessions.location(request.actorId, uuid(request.params.sessionId)));
  app.patch<{ Params: { sessionId: string } }>('/v1/agent-sessions/:sessionId', request => sessions.rename(request.actorId, uuid(request.params.sessionId), request.body));
  app.get<{ Params: { sessionId: string } }>('/v1/agent-sessions/:sessionId', request => sessions.read(request.actorId, uuid(request.params.sessionId), request.query));
  app.post<{ Params: { sessionId: string } }>('/v1/agent-sessions/:sessionId/messages', async (request, reply) => { const task=await sessions.send(request.actorId, uuid(request.params.sessionId), request.body, text(request.headers['idempotency-key'], 128));await accepted?.(task);return reply.code(201).send(task); });
  app.post<{Params:{sessionId:string}}>('/v1/agent-sessions/:sessionId/queue',async r=>{
    const id=uuid(r.headers['idempotency-key']);
    const result=await sessions.addInput(r.actorId,uuid(r.params.sessionId),id,'queue',r.body);
    return {id,state:result.state};
  });
  app.patch<{Params:{sessionId:string;inputId:string}}>('/v1/agent-sessions/:sessionId/queue/:inputId',async r=>{
    await sessions.reviseQueued(r.actorId,uuid(r.params.sessionId),uuid(r.params.inputId),r.body);
    return {ok:true};
  });
  app.post<{Params:{sessionId:string}}>('/v1/agent-sessions/:sessionId/queue/resume',async r=>{
    record(r.body,[]);
    await sessions.resumeQueue(r.actorId,uuid(r.params.sessionId));
    return {ok:true};
  });
  for(const action of ['cancel','retry'] as const) app.post<{Params:{sessionId:string;inputId:string}}>(`/v1/agent-sessions/:sessionId/queue/:inputId/${action}`,async r=>{
    record(r.body,[]);
    await sessions.changeQueued(r.actorId,uuid(r.params.sessionId),uuid(r.params.inputId),action);
    return {ok:true};
  });
  app.post<{Params:{sessionId:string}}>('/v1/agent-sessions/:sessionId/steer',async r=>{
    const body=record(r.body,['execution_id','text','source_input_id']);
    const id=uuid(r.headers['idempotency-key']),session_id=uuid(r.params.sessionId),execution_id=uuid(body.execution_id),message=text(body.text,4000);
    if(!steer) throw new AppError(409,'steer_unsupported');
    const receipt=await sessions.addInput(r.actorId,session_id,id,'steer',{text:message},execution_id,body.source_input_id===undefined?undefined:uuid(body.source_input_id));
    if(!receipt.connection) return {id,state:receipt.state};
    let state:'sent'|'blocked'|'uncertain'='sent';
    let detail:string|null=null;
    try {await steer(receipt.connection,{id,session_id,execution_id,text:message});}
    catch(e){ state=e instanceof AppError && e.code==='turn_not_running'?'blocked':'uncertain';detail=state==='blocked'?'Turn is no longer accepting input.':'Delivery could not be confirmed.'; }
    await sessions.finishSteer(id,state,detail);
    return {id,state};
  });
  for (const operation of ['stop', 'end'] as const) app.post<{ Params: { sessionId: string } }>(`/v1/agent-sessions/:sessionId/${operation}`, async request => {
    record(request.body, []);
    const id=uuid(request.params.sessionId);const result=await sessions.control(request.actorId,id,operation);await stopped?.(id);return result;
  });
}
