import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAgentSessionList } from './useAgentSessionList.js';
const mocks=vi.hoisted(()=>({subscriptions:[] as {read:()=>Promise<void>;revoke:()=>void;stop:ReturnType<typeof vi.fn>}[]}));
vi.mock('../../shared/realtime/live-updates.js',()=>({
 subscribeUpdates:(_scope:string,_id:string,read:()=>Promise<void>,revoke:()=>void)=>{const stop=vi.fn();mocks.subscriptions.push({read,revoke,stop});void read();return stop;},
 invalidateUpdates:vi.fn(),
}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();mocks.subscriptions=[];});
it('appends bounded pages and keeps older rows on a workspace refresh',async()=>{
 const fetch=vi.fn(async(path:string)=>({ok:true,json:async()=>path.includes('before=')?{items:[{id:'older'}],next_cursor:null}:{items:[{id:'recent'}],next_cursor:'cursor'}}));
 vi.stubGlobal('fetch',fetch);
 const {result}=renderHook(()=>useAgentSessionList('workspace'));
 await waitFor(()=>expect(result.current.items[0]?.id).toBe('recent'));
 act(()=>result.current.loadMore());
 await waitFor(()=>expect(result.current.items.map(item=>item.id)).toEqual(['recent','older']));
 expect(fetch.mock.calls.at(-1)?.[0]).toBe('/v1/workspaces/workspace/agent-sessions?before=cursor');
 expect(result.current.next_cursor).toBeNull();
 await act(async()=>mocks.subscriptions[0]!.read());
 expect(result.current.items.map(item=>item.id)).toEqual(['recent','older']);
});
it('ignores late results from a previous workspace and clears revoked session titles',async()=>{
 let finish!:(value:unknown)=>void;
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>({ok:true,json:async()=>path.includes('/old/')?new Promise(resolve=>{finish=resolve;}):{items:[{id:'new'}],next_cursor:null}})));
 const {result,rerender}=renderHook(({workspace})=>useAgentSessionList(workspace),{initialProps:{workspace:'old'}});
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 rerender({workspace:'new'});
 await waitFor(()=>expect(result.current.items[0]?.id).toBe('new'));
 expect(mocks.subscriptions[0]!.stop).toHaveBeenCalledOnce();
 await act(async()=>{finish({items:[{id:'private-old'}],next_cursor:null});});
 expect(result.current.items.map(item=>item.id)).toEqual(['new']);
 act(()=>mocks.subscriptions.at(-1)!.revoke());
 expect(result.current.items).toEqual([]);
 expect(result.current.error).toBeTruthy();
});

it('refreshes once at the idle deadline and stops scheduling when only exempt channels remain',async()=>{
 vi.useFakeTimers();
 try {
  const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({items:[{id:'expiring',sidebar_expires_at:'2026-11-14T12:00:00Z',sidebar_expires_in_ms:1000}],next_cursor:null})})
    .mockResolvedValue({ok:true,json:async()=>({items:[{id:'starred'}],next_cursor:null})});
  vi.stubGlobal('fetch',fetch);
  const {result}=renderHook(()=>useAgentSessionList('workspace'));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(result.current.items[0]?.id).toBe('expiring');
  await act(async()=>{await vi.advanceTimersByTimeAsync(999);});
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(2);});
  expect(result.current.items[0]?.id).toBe('starred');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1_000_000);});
  expect(fetch).toHaveBeenCalledTimes(2);
 } finally {vi.useRealTimers();}
});
