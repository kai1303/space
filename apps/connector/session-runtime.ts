import type { AgentRuntime } from './agent-runtime.js';

// Each live provider runtime owns one session. Idle runtimes can be reopened from durable provider storage.
export async function sessionRuntime(create: (onExit:()=>void) => Promise<AgentRuntime>, capacity = 4, onUnavailable=()=>{}): Promise<AgentRuntime> {
  const sessions = new Map<string, { runtime: AgentRuntime; active: boolean }>();
  let spare: AgentRuntime | undefined, closed = false;
  const healthy=()=>!!spare?.alive() || [...sessions.values()].some(item=>item.runtime.alive());
  const exited=()=>{if(!closed && !healthy())onUnavailable();};
  spare=await create(exited);
  return {
    alive: () => !closed && healthy(),
    stop() { closed = true; spare?.stop(); for (const item of sessions.values()) item.runtime.stop(); sessions.clear(); },
    async invoke(request, emit, signal, controls) {
      if (closed || signal.aborted) throw new Error('Agent unavailable.');
      const id = request.session_id;
      let item = sessions.get(id);
      if (item?.active) throw new Error('Agent session is busy.');
      if (item && !item.runtime.alive()) throw new Error('Agent session is unavailable. Restart the connector.');
      if (!item) {
        if (sessions.size >= capacity) {
          const idle = [...sessions].find(([, value]) => !value.active);
          if (!idle) throw new Error('Agent capacity reached.');
          idle[1].runtime.stop(); sessions.delete(idle[0]);
        }
        // Occupy the session before asynchronous startup so concurrent sends cannot overlap.
        item = {runtime: spare ?? {alive:()=>false,stop(){},async invoke(){throw new Error('Agent starting.');}}, active:true};
        spare = undefined; sessions.set(id,item);
        try { if (!item.runtime.alive()) item.runtime = await create(exited); if(closed || signal.aborted){item.runtime.stop();throw new Error('Agent unavailable.');} }
        catch(error) { sessions.delete(id); throw error; }
      }
      item.active = true;
      try { await item.runtime.invoke(request,emit,signal,controls); }
      finally { item.active = false; }
    },
  };
}
