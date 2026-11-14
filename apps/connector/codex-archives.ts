import { watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Socket } from 'socket.io-client';
import { projectToken, record, uuid } from '@space/contracts';
import type { SyncArchive } from './agent-runtime.js';

export function codexArchives(socket:Socket,directory:string,sync:SyncArchive) {
  let watcher:ReturnType<typeof watch>|undefined, ready=false, busy=false;
  function stop() { watcher?.close();watcher=undefined;ready=false; }
  socket.on('disconnect',stop);
  socket.on('agent.archive.sync',async(raw:unknown,ack:unknown)=>{
    if (typeof ack!=='function') return;
    if (!ready || busy) {ack({error:'busy'});return;}
    busy=true;
    try {
      const v=record(raw,['session_id','project_token','personal','desired','thread_id']);
      if (typeof v.personal!=='boolean' || v.desired!==null && typeof v.desired!=='boolean') throw new Error();
      const mapping=await sync({session_id:uuid(v.session_id),personal:v.personal,desired:v.desired,
        thread_id:v.thread_id===null?null:uuid(v.thread_id),
        project_token:v.project_token===null?null:projectToken(v.project_token)});
      ack({mapping});
    } catch {ack({error:'archive_unavailable'});}
    finally {busy=false;}
  });
  return {
    stop,
    start() {
      if (ready) return;
      // Codex moves rollout files when another app-server archives or restores a thread.
      watcher=watch(join(directory,'codex'),{recursive:true,persistent:false},(_event,file)=>{
        if (!file || !socket.connected) return;
        const name=basename(file), parent=dirname(file);
        try {
          if (name==='thread.json' && basename(dirname(parent))==='sessions')
            socket.emit('agent.archive.changed',{session:uuid(basename(parent))});
          if (basename(parent)==='archived_sessions') {
            const match=/^rollout-.*-([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\.jsonl$/i.exec(name);
            if (match) socket.emit('agent.archive.changed',{thread:uuid(match[1])});
          }
        } catch { /* Only managed session and native thread IDs are reported. */ }
      });
      watcher.on('error',()=>{stop();socket.disconnect().connect();});
      ready=true;
      socket.emit('agent.archive.ready');
    },
  };
}
