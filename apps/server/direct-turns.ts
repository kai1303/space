import type { FastifyInstance } from 'fastify';
import type { Server, Socket } from 'socket.io';
import {AppError,record,uuid,parseAgentEvent,type Task} from '@space/contracts';
import type {PostgresStore} from '@space/postgres/store';
import type {AgentConnectionStore} from '@space/postgres/agent-connections';
import type {RealtimeWork} from './realtime-work.js';

export function directTurns(app:FastifyInstance,io:Server,tasks:PostgresStore,invalidate:(keys?:readonly string[])=>void) {
  const agents=io.of('/agents'),starting=new Map<string,Promise<void>>();
  const timers=new Map<string,ReturnType<typeof setTimeout>>();
  async function ask(connection:string,name:string,input:unknown) {
    const replies=await agents.to(`connection:${connection}`).timeout(2500).emitWithAck(name,input).catch(()=>[]);
    if(replies.length!==1 || replies[0]?.data!==true)throw new AppError(409,replies[0]?.error==='agent_busy'?'agent_busy':replies[0]?.error==='agent_capacity'?'agent_capacity':'agent_unavailable');
  }
  tasks.admitLocalTurn=async(connection,session)=>{
    if(!listener)throw new AppError(503,'agent_unavailable');
    await ask(connection,'agent.turn.capacity',{session_id:session});
  };
  const dispatch=(id:string):Promise<void>=>{
    if(starting.has(id))return starting.get(id)!;
    if(starting.size>=128 || timers.size>=4096)return (async()=>{const delivery=await tasks.directDelivery(id);if(delivery && await tasks.failUnstartedDelivery(delivery,'agent_capacity'))throw new AppError(503,'agent_capacity');})();
    const run=(async()=>{
      const delivery=await tasks.directDelivery(id);
      if(!delivery || delivery.last_sequence>0)return;
      try {
        const prepared=await tasks.prepareDelivery(delivery,delivery.connection_id);
        if(!prepared)return;
        await ask(delivery.connection_id,'agent.turn.start',prepared.request);
        // A successful offer must promptly produce a persisted start event. It is never queued for retry.
        if(timers.has(id))return;
        const timer=setTimeout(()=>{timers.delete(id);void (async()=>{
          const pending=await tasks.directDelivery(id);
          if(pending)await tasks.failUnstartedDelivery(pending,'agent_start_timeout');
        })().catch(()=>{});},10000);
        timers.set(id,timer);
      }catch(error){if(await tasks.failUnstartedDelivery(delivery,'agent_start_failed')){if(error instanceof AppError && ['agent_busy','agent_capacity'].includes(error.code))throw error;throw new AppError(409,'agent_unavailable');}}
    })().finally(()=>starting.delete(id));
    starting.set(id,run);return run;
  };
  const connect=()=>tasks.pool.connect();
  let listener:Awaited<ReturnType<typeof connect>>|undefined;
  let closing=false,retries=0,retry:ReturnType<typeof setTimeout>|undefined;
  const retryListen=()=>{
    if(closing || retry || retries>=5)return;
    retry=setTimeout(()=>{retry=undefined;void listen().catch(retryListen);},Math.min(1000*2**retries++,15000));
  };
  async function listen(){
    const client=await connect();
    client.on('notification',message=>{if(message.channel!=='space_direct_turn')return;try{const input=JSON.parse(message.payload??'{}');if(Array.isArray(input.keys)&&input.keys.length<=8&&input.keys.every((key:unknown)=>typeof key==='string')){invalidate(input.keys);return;}const id=uuid(input.task_id);void dispatch(id).catch(()=>{});}catch{}});
    client.once('error',()=>{client.release(true);if(listener===client)listener=undefined;retryListen();});
    try{await client.query('LISTEN space_direct_turn');listener=client;retries=0;}
    catch(error){client.release(true);throw error;}
  }
  app.addHook('onReady',async()=>{
    await listen();
    // A server restart never resumes an uncertain provider invocation.
    const cutoff=new Date();let cursor:string|null=null;
    for(;;){
      const {rows}: {rows:{id:string;task_id:string}[]}=await tasks.pool.query<{id:string;task_id:string}>("SELECT id,task_id FROM outbox WHERE direct AND state='delivering' AND lease_until<$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 128",[cutoff,cursor]);
      for(const row of rows){const delivery=await tasks.directDelivery(row.task_id);if(delivery)await tasks.failDelivery(delivery,'local_execution_interrupted',true);}
      if(rows.length<128)break;cursor=rows.at(-1)!.id;
    }
  });
  app.addHook('onClose',async()=>{closing=true;clearTimeout(retry);for(const timer of timers.values())clearTimeout(timer);if(listener){await listener.query('UNLISTEN space_direct_turn').catch(()=>{});listener.release();}});
  const stop=async(session:string)=>{
    const {rows}=await tasks.pool.query("SELECT o.direct_connection AS connection_id,t.id,t.active_execution_id FROM tasks t JOIN outbox o ON o.task_id=t.id WHERE t.session_id=$1 AND o.direct AND o.last_error='session_stopped' ORDER BY t.created_at DESC LIMIT 1",[session]);
    const row=rows[0];if(row)agents.to(`connection:${row.connection_id}`).emit('agent.turn.stop',{session_id:session,execution_id:row.active_execution_id});
  };
  const accepted=async(task:Task)=>{
    if(task.status==='running')await dispatch(task.id);
    if(task.status==='failed' || task.status==='running'){
      const result=await tasks.pool.query('SELECT last_error FROM outbox WHERE task_id=$1 AND direct',[task.id]);
      if(['agent_start_failed','agent_start_timeout','agent_capacity'].includes(result.rows[0]?.last_error))throw new AppError(409,'agent_start_failed');
    }
  };
  return {dispatch,stop,accepted};
}

export function registerDirectTurns(socket:Socket,connections:AgentConnectionStore,tasks:PostgresStore,work:RealtimeWork) {
  const identity=socket.data.agent as {id:string;connection_id:string};
  void socket.join(`connection:${identity.connection_id}`);
  let pending=0;
  const active=new Map<string,Awaited<ReturnType<PostgresStore['directDelivery']>>>();
  for(const operation of ['event','finish','fail'] as const)socket.on(`agent.turn.${operation}`,(raw:unknown,ack:unknown)=>{
    if(typeof ack!=='function')return;
    if(pending>=32){ack({error:'busy'});return;}
    pending++;
    void work.run(socket.id,async()=>{
      try{
        await connections.authenticateConnection(socket.data.token,identity.connection_id);
        const input=record(raw,operation==='event'?['task_id','event']:['task_id']);
        const id=uuid(input.task_id),delivery=await tasks.directDelivery(id,identity.id);
        if(!delivery){
          const stopped=await tasks.pool.query("SELECT 1 FROM outbox o JOIN tasks t ON t.id=o.task_id WHERE o.task_id=$1 AND o.direct AND o.direct_connection=$2 AND t.installation_id=$3 AND o.last_error='session_stopped'",[id,identity.connection_id,identity.id]);
          if(stopped.rowCount)throw new AppError(409,'agent_session_stopped');
          throw new AppError(409,'stale_execution');
        }
        if(delivery.connection_id!==identity.connection_id)throw new AppError(409,'stale_execution');
        if(!active.has(id) && active.size>=4)throw new AppError(503,'agent_capacity');
        active.set(id,delivery);
        if(operation==='event'){
          if(JSON.stringify(input.event).length>80000)throw new AppError(400,'agent_event_too_large');
          await tasks.acceptEvent(identity.id,parseAgentEvent(input.event),delivery,identity.connection_id);

        }else if(operation==='finish'){
          if(!await tasks.executionTerminal(delivery.execution_id))throw new AppError(409,'missing_terminal_event');
          await tasks.ackDelivery(delivery);active.delete(id);
        }else {await tasks.failDelivery(delivery,'local_execution_failed',true);active.delete(id);}
        const changed=await tasks.pool.query('SELECT t.workspace_id,t.thread_id,th.channel_id FROM tasks t JOIN threads th ON th.id=t.thread_id WHERE t.id=$1',[id]);
        const row=changed.rows[0];if(row)await tasks.pool.query("SELECT pg_notify('space_direct_turn',$1)",[JSON.stringify({keys:[`task:${id}`,`thread:${row.thread_id}`,`channel:${row.channel_id}`,`workspace:${row.workspace_id}`]})]);
        ack({data:true});
      }catch(error){ack({error:error instanceof AppError?error.code:'internal_error'});}
    }).catch(()=>ack({error:'internal_error'})).finally(()=>pending--);
  });
  socket.on('disconnect',()=>{for(const delivery of active.values())if(delivery)void tasks.failDelivery(delivery,'local_execution_interrupted',true).catch(()=>{});active.clear();});
}
