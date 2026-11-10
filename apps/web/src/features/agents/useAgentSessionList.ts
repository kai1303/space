import { useEffect, useState } from 'react';
import type { WorkspaceAgentSession } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { errorText } from '../../shared/api/error-text.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';

type Page = {items: WorkspaceAgentSession[]; next_cursor: string | null};
const empty = {items: [] as WorkspaceAgentSession[], next_cursor: null as string | null, revoked: false};
export function useAgentSessionList(workspace: string) {
  const [pagination,setPagination]=useState({workspace,before:''});
  const before=pagination.workspace===workspace?pagination.before:'';
  const key=`${workspace}:${before}`;
  const [state,setState]=useState({key:'',...empty,loading:true,error:''});
  useEffect(()=>{
    const controller = new AbortController();
    let active=true;
    const stop=subscribeUpdates('workspace',workspace,async()=>{
      try {
        const page=await request<Page>(`/workspaces/${workspace}/agent-sessions${before?`?before=${before}`:''}`, undefined, undefined, undefined, controller.signal);
        if(active)setState({key,revoked:false,items:Array.isArray(page.items)?page.items:[],next_cursor:page.next_cursor??null,loading:false,error:''});
      } catch(reason) {
        if(active)setState({key,...empty,loading:false,error:errorText(reason)});
      }
    },()=>{active=false;controller.abort();setState({key,...empty,revoked:true,loading:false,error:'Agent sessions are unavailable.'});});
    return()=>{active=false;controller.abort();stop();};
  },[workspace,before,key]);
  const current=state.key===key?state:{...empty,loading:true,error:''};
  return {...current,hasPrevious:!!before,
    older:()=>{if(current.next_cursor)setPagination({workspace,before:current.next_cursor});},
    first:()=>setPagination({workspace,before:''}),
    refresh:()=>invalidateUpdates('workspace',workspace),
  };
}
