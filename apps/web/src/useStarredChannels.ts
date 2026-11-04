import { useEffect, useRef, useState } from 'react';
import type { Page } from '@space/contracts';
import { request } from './chat-client.js';
import { subscribeUpdates } from './live-updates.js';
type StarredConversation = {id:string;name:string;kind:string;private:boolean};
export function useStarredChannels(workspace:string,channel?:string) {
  const [pagination,setPagination]=useState({workspace,after:''});
  const after=pagination.workspace===workspace?pagination.after:'';
  const setAfter=(after:string)=>setPagination({workspace,after});
  const [state,setState]=useState({key:'',conversations:[] as StarredConversation[],active:false,next:null as string|null});
  const refresh=useRef<()=>Promise<void>>(async()=>{});
  const alive=useRef(false),writing=useRef(false);
  const key=`${workspace}:${channel??''}:${after}`;
  useEffect(()=>{
    let active=true,version=0;alive.current=true;
    const read=async()=>{const attempt=++version;try{
      const [page,exact]=await Promise.all([
        channel?Promise.resolve({items:[],next_cursor:null} as Page<StarredConversation>):request<Page<StarredConversation>>(`/workspaces/${workspace}/hub/starred?limit=100${after?`&after=${after}`:''}`),
        channel?request<{active:boolean}>(`/workspaces/${workspace}/hub/starred/${channel}`):Promise.resolve({active:false}),
      ]);
      if(active&&attempt===version)setState({key,conversations:Array.isArray(page.items)?page.items:[],active:exact.active===true,next:page.next_cursor});
    }catch{if(active&&attempt===version)setState({key,conversations:[],active:false,next:null});}};
    refresh.current=read;
    const stop=subscribeUpdates('workspace',workspace,read,()=>{version++;active=false;alive.current=false;setState({key,conversations:[],active:false,next:null});});
    return()=>{version++;active=false;alive.current=false;stop();};
  },[workspace,channel,after,key]);
  const current=state.key===key?state:{conversations:[],active:false,next:null};
  return {...current,ids:current.conversations.map(item=>item.id),hasPrevious:!!after,loadMore:()=>{if(current.next)setAfter(current.next);},first:()=>setAfter(''),toggle:async(id:string)=>{
    if(!alive.current||writing.current)return;writing.current=true;
    try{await request(`/workspaces/${workspace}/hub/starred/${id}`,{active:channel===id?!current.active:!current.conversations.some(item=>item.id===id)});if(alive.current)await refresh.current();}
    finally{writing.current=false;}
  }};
}
