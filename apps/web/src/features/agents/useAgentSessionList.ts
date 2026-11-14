import { useEffect, useRef, useState } from 'react';
import type { WorkspaceAgentSession } from '@space/contracts';
import { readWorkspaceQuery, useWorkspaceQueryCache } from '../../shared/realtime/workspace-query-cache.js';
import { errorText } from '../../shared/api/error-text.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';

type Page = {items: WorkspaceAgentSession[]; next_cursor: string | null};
const empty: Page = {items: [], next_cursor: null};
function sessionPage(page: Page | undefined): Page {
  return Array.isArray(page?.items) ? {items:page.items,next_cursor:page.next_cursor ?? null} : empty;
}

export function useAgentSessionList(workspace: string) {
  const cache = useWorkspaceQueryCache(workspace);
  const key = `/workspaces/${workspace}/agent-sessions`;
  const [state,setState] = useState({owner:cache,key:'',...empty,loading:true,error:'',revoked:false});
  const append = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true, pages = 1, running = false;
    let current = sessionPage(cache?.peek<Page>(key));
    let controller: AbortController;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const deadlines = new Map<string, {stamp:string; at:number}>();
    function scheduleExpiry() {
      clearTimeout(expiry);
      const now = performance.now();
      let earliest = Infinity;
      const ids = new Set(current.items.map(item => item.id));
      for (const id of deadlines.keys()) if (!ids.has(id)) deadlines.delete(id);
      for (const item of current.items) {
        if (!item.sidebar_expires_at || item.sidebar_expires_in_ms === undefined) { deadlines.delete(item.id); continue; }
        let deadline = deadlines.get(item.id);
        if (!deadline || deadline.stamp !== item.sidebar_expires_at || deadline.at <= now) {
          deadline = {stamp:item.sidebar_expires_at, at:now + item.sidebar_expires_in_ms};
          deadlines.set(item.id, deadline);
        }
        earliest = Math.min(earliest, deadline.at);
      }
      if (Number.isFinite(earliest)) expiry = setTimeout(() => {
        cache?.invalidate(key);
        void read(false);
      }, Math.max(0, earliest - now) + 1);
    }
    function publish(loading: boolean, error = '', revoked = false) {
      setState({owner:cache,key,...current,loading,error,revoked});
    }
    async function read(more: boolean) {
      if (!active || (more && (running || !current.next_cursor))) return;
      controller?.abort();
      controller = new AbortController();
      const {signal} = controller;
      running = true;
      if (more) pages++;
      publish(true);
      let cursor = more ? current.next_cursor : null;
      const items = new Map((more ? current.items : []).map(item => [item.id,item]));
      try {
        const count = more ? 1 : pages;
        for (let pageNumber = 0; pageNumber < count; pageNumber++) {
          const path = cursor ? key + '?before=' + encodeURIComponent(cursor) : key;
          const page = sessionPage(await readWorkspaceQuery<Page>(cache,path,signal));
          if (!active || signal.aborted) return;
          for (const item of page.items) items.set(item.id,item);
          cursor = page.next_cursor;
          if (!cursor) break;
        }
        current = {items:[...items.values()],next_cursor:cursor};
        scheduleExpiry();
        publish(false);
      } catch (reason) {
        if (!active || signal.aborted) return;
        // A refreshed window may contain rows whose channel access was revoked.
        if (!more || ['unauthorized','forbidden','not_found'].includes((reason as Error).message)) current = empty;
        if (more) pages--;
        publish(false,errorText(reason));
      } finally {
        if (!signal.aborted) running = false;
      }
    }
    append.current = () => { void read(true); };
    const stop = subscribeUpdates('workspace',workspace,() => read(false),() => {
      active = false; clearTimeout(expiry); controller?.abort(); current = empty;
      publish(false,'Agent sessions are unavailable.',true);
    });
    return () => { active = false; clearTimeout(expiry); controller?.abort(); stop(); };
  },[cache,key,workspace]);
  const warm = cache?.peek<Page>(key);
  const current = state.owner === cache && state.key === key ? state : {...sessionPage(warm),loading:!warm,error:'',revoked:false};
  return {...current, loadMore:() => append.current(), refresh:() => invalidateUpdates('workspace',workspace)};
}
