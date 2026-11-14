import type { Socket } from 'socket.io';
import { record, uuid } from '@space/contracts';
import type { AgentConnectionStore } from '@space/postgres/agent-connections';
import type { RealtimeWork, SubscriptionIndex } from './realtime-work.js';

type Scan = {session?:string; thread?:string; pending?:boolean};

export function registerCodexArchives(socket:Socket, store:AgentConnectionStore, work:RealtimeWork, wakes:SubscriptionIndex) {
  const {id,connection_id} = socket.data.agent as {id:string;connection_id:string};
  const queue = new Map<string,Scan>();
  let enabled=false, running=false, retries=0, retry:ReturnType<typeof setTimeout>|undefined;
  const run = <T>(job:()=>Promise<T>) => work.run(socket.id,job);
  async function scan(filter:Scan) {
    let after:string|null=null;
    let failed=false;
    for (;;) {
      if (!socket.connected) return;
      const page = await run(async()=>{
        await store.authenticateConnection(socket.data.token,connection_id);
        return store.archivePage(id,connection_id,after,!!filter.pending,filter.session??null,filter.thread??null);
      });
      for (const row of page) {
        if (!socket.connected) return;
        try {
          const reply=await socket.timeout(55000).emitWithAck('agent.archive.sync',{
            session_id:row.session_id, project_token:row.project_token, personal:row.personal, desired:row.desired, thread_id:row.native_thread_id,
          });
          if (reply?.mapping===null) continue; // A session may have no native turn yet.
          const mapping=record(reply?.mapping,['thread_id','archived']);
          if (typeof mapping.archived!=='boolean') throw new Error('Invalid archive response.');
          const archived=mapping.archived, thread=uuid(mapping.thread_id);
          await run(()=>store.recordArchive(id,connection_id,row.session_id,row.revision,thread,archived));
        } catch { failed=true; }
      }
      if (page.length<16) break;
      after=page.at(-1)!.session_id;
    }
    if (failed) throw new Error('Archive sync incomplete.');
  }
  async function drain() {
    if (running || !enabled) return;
    running=true;
    try {
      while (queue.size && socket.connected) {
        const [key,filter]=queue.entries().next().value!;
        queue.delete(key);
        try { await scan(filter); }
        catch {
          if (socket.connected && !retry && retries<3) {
            retry=setTimeout(()=>{retry=undefined;enqueue('all',{});},1000*2**retries++);
          }
        }
      }
    } finally { running=false; }
  }
  function enqueue(key:string, filter:Scan) {
    if (!enabled) return;
    if (queue.size>=64) { queue.clear();queue.set('all',{}); }
    else if (!queue.has('all')) queue.set(key,filter);
    void drain();
  }
  socket.on('agent.archive.ready',()=>{
    enabled=true;enqueue('all',{});
  });
  socket.on('agent.archive.changed',(raw:unknown)=>{
    if (!enabled) return;
    try {
      const input=record(raw,['session','thread']);
      if (input.session) { const session=uuid(input.session);enqueue(session,{session}); }
      else if (input.thread) { const thread=uuid(input.thread);enqueue(thread,{thread}); }
    } catch { /* Ignore malformed filesystem hints. */ }
  });
  const stop=wakes.add([`codex-archive:${id}`],()=>enqueue('pending',{pending:true}));
  socket.once('disconnect',()=>{stop();clearTimeout(retry);queue.clear();});
}
