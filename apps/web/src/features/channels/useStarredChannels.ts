import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentSessionReference, Page } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';
type StarredConversation = {id:string;name:string;kind:string;private:boolean;session?:AgentSessionReference};
type PendingStar = { active: boolean; conversation?: StarredConversation };
const pendingStars = new Map<string, ReadonlyMap<string, PendingStar>>();
const emptyPending: ReadonlyMap<string, PendingStar> = new Map();
const listeners = new Set<() => void>();
function subscribePending(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function updatePending(scope: string, id: string, pending?: PendingStar) {
  const next = new Map(pendingStars.get(scope));
  if (pending) next.set(id, pending); else next.delete(id);
  if (next.size) pendingStars.set(scope, next); else pendingStars.delete(scope);
  for (const listener of listeners) listener();
}
export function useStarredChannels(workspace:string,channel?:string,viewerId='',resource:'starred'|'starred-sessions'='starred') {
  const scope = `${viewerId}:${workspace}:${resource}`;
  const optimistic = useSyncExternalStore(subscribePending, useCallback(() => pendingStars.get(scope) ?? emptyPending, [scope]));
  const [pagination,setPagination]=useState({workspace,after:''});
  const after=pagination.workspace===workspace?pagination.after:'';
  const setAfter=(after:string)=>setPagination({workspace,after});
  const [state,setState]=useState({key:'',conversations:[] as StarredConversation[],active:false,next:null as string|null});
  const alive=useRef(false),writing=useRef(false);
  const key=`${scope}:${channel??''}:${after}`;
  useEffect(()=>{
    let active=true,version=0;alive.current=true;
    const read=async()=>{const attempt=++version;try{
      const [page,exact]=await Promise.all([
        channel?Promise.resolve({items:[],next_cursor:null} as Page<StarredConversation>):request<Page<StarredConversation>>(`/workspaces/${workspace}/hub/${resource}?limit=100${after?`&after=${after}`:''}`),
        channel?request<{active:boolean}>(`/workspaces/${workspace}/hub/${resource}/${channel}`):Promise.resolve({active:false}),
      ]);
      if(active&&attempt===version)setState({key,conversations:Array.isArray(page.items)?page.items:[],active:exact.active===true,next:page.next_cursor});
    }catch{if(active&&attempt===version)setState({key,conversations:[],active:false,next:null});}};
    const stop=subscribeUpdates('workspace',workspace,read,()=>{version++;active=false;alive.current=false;setState({key,conversations:[],active:false,next:null});});
    return()=>{version++;active=false;alive.current=false;stop();};
  },[workspace,channel,after,key]);
  const current=state.key===key?state:{conversations:[],active:false,next:null};
  const conversations = current.conversations.filter(item => optimistic.get(item.id)?.active !== false);
  for (const [id, pending] of optimistic) if (pending.active && pending.conversation && !conversations.some(item => item.id === id)) conversations.push(pending.conversation);
  const active = (channel ? optimistic.get(channel)?.active : undefined) ?? current.active;
  return {...current,conversations,active,busy:!!channel&&optimistic.has(channel),ids:conversations.map(item=>item.id),hasPrevious:!!after,loadMore:()=>{if(current.next)setAfter(current.next);},first:()=>setAfter(''),toggle:async(id:string,conversation?:StarredConversation)=>{
    if(!alive.current||writing.current||pendingStars.get(scope)?.has(id))return;writing.current=true;
    const desired = {active:channel===id?!active:!conversations.some(item=>item.id===id),conversation:conversation??conversations.find(item=>item.id===id)};
    updatePending(scope,id,desired);
    try{await request(`/workspaces/${workspace}/hub/${resource}/${id}`,{active:desired.active});await invalidateUpdates('workspace',workspace);}
    finally{updatePending(scope,id);writing.current=false;}
  }};
}
