import { useEffect, useState } from 'react';
import type { WorkspaceAgentSession } from '@space/contracts';
import { readWorkspaceQuery, useWorkspaceQueryCache } from '../../shared/realtime/workspace-query-cache.js';
import { errorText } from '../../shared/api/error-text.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';

type Page = {items: WorkspaceAgentSession[]; next_cursor: string | null};
const empty = {items: [] as WorkspaceAgentSession[], next_cursor: null as string | null, revoked: false};
export function useAgentSessionList(workspace: string) {
  const [pagination,setPagination]=useState({workspace,before:''});
  const before=pagination.workspace===workspace?pagination.before:'';
  const workspaceCache = useWorkspaceQueryCache(workspace);
  const pageCache = before ? undefined : workspaceCache;
  const key = `/workspaces/${workspace}/agent-sessions${before ? `?before=${before}` : ''}`;
  const [state,setState]=useState({owner:workspaceCache,key:'',...empty,loading:true,error:''});
  useEffect(()=>{
    const controller = new AbortController();
    let active=true;
    const stop=subscribeUpdates('workspace',workspace,async()=>{
      try {
        const page = await readWorkspaceQuery<Page>(pageCache, key, controller.signal);
        if(active)setState({owner:workspaceCache,key,revoked:false,items:Array.isArray(page.items)?page.items:[],next_cursor:page.next_cursor??null,loading:false,error:''});
      } catch(reason) {
        if(active)setState({owner:workspaceCache,key,...empty,loading:false,error:errorText(reason)});
      }
    },()=>{active=false;controller.abort();setState({owner:workspaceCache,key,...empty,revoked:true,loading:false,error:'Agent sessions are unavailable.'});});
    return()=>{active=false;controller.abort();stop();};
  },[workspace,workspaceCache,pageCache,key]);
  const matches = state.key === key && state.owner === workspaceCache;
  const warm = !matches ? pageCache?.peek<Page>(key) : undefined;
  const current = matches ? state : { ...empty, ...warm, loading: !warm, error: '' };
  const {items, next_cursor, loading, error, revoked} = current;
  return {items, next_cursor, loading, error, revoked, hasPrevious:!!before,
    older:()=>{if(current.next_cursor)setPagination({workspace,before:current.next_cursor});},
    first:()=>setPagination({workspace,before:''}),
    refresh:()=>invalidateUpdates('workspace',workspace),
  };
}
