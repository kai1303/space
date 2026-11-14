import {useEffect, useState} from 'react';
import type {ChatMessage} from '@space/contracts';
import {request} from '../../shared/api/request.js';
import {subscribeUpdates} from '../../shared/realtime/live-updates.js';

// Hydrate only the current history window. Personal flags never enter shared chat events.
export function useSavedMessages(workspace:string,channel:string,actor:string,messages:ChatMessage[]) {
  const ids=messages.filter(m=>!m.deleted_at&&!m.encrypted&&!m.agent_session_id).map(m=>m.id).join(',');
  const [snapshot,setSnapshot]=useState<{scope:string; saved:Set<string>}>();
  const scope=workspace+':'+channel+':'+actor+':'+ids;
  useEffect(()=>{
    if(!ids) return;
    const controller=new AbortController();
    const stop=subscribeUpdates('actor',actor,async()=>{
      const keys=ids.split(','); const saved=new Set<string>();
      // A detached parent can add one row to an otherwise full history window.
      for(let i=0;i<keys.length;i+=500){
        const page=await request<{ids:string[]}>(`/workspaces/${workspace}/hub/saved/state/${channel}`,{ids:keys.slice(i,i+500)},undefined,'POST',controller.signal,actor);
        for(const id of page.ids) saved.add(id);
      }
      if(!controller.signal.aborted)setSnapshot({scope,saved});
    },()=>setSnapshot(undefined));
    return ()=>{controller.abort();stop();};
  },[scope]);
  return snapshot?.scope===scope?snapshot.saved:undefined;
}
