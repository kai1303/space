import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAgentSessionList } from './useAgentSessionList.js';
const mocks=vi.hoisted(()=>({subscriptions:[] as {read:()=>Promise<void>;revoke:()=>void;stop:ReturnType<typeof vi.fn>}[]}));
vi.mock('../../shared/realtime/live-updates.js',()=>({
 subscribeUpdates:(_scope:string,_id:string,read:()=>Promise<void>,revoke:()=>void)=>{const stop=vi.fn();mocks.subscriptions.push({read,revoke,stop});void read();return stop;},
 invalidateUpdates:vi.fn(),
}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();mocks.subscriptions=[];});
it('replaces bounded pages and returns to recent sessions',async()=>{
 const fetch=vi.fn(async(path:string)=>({ok:true,json:async()=>path.includes('before=')?{items:[{id:'older'}],next_cursor:null}:{items:[{id:'recent'}],next_cursor:'cursor'}}));
 vi.stubGlobal('fetch',fetch);
 const {result}=renderHook(()=>useAgentSessionList('workspace'));
 await waitFor(()=>expect(result.current.items[0]?.id).toBe('recent'));
 act(()=>result.current.older());
 await waitFor(()=>expect(result.current.items.map(item=>item.id)).toEqual(['older']));
 expect(fetch.mock.calls.at(-1)?.[0]).toBe('/v1/workspaces/workspace/agent-sessions?before=cursor');
 expect(result.current.hasPrevious).toBe(true);
 act(()=>result.current.first());
 await waitFor(()=>expect(result.current.items[0]?.id).toBe('recent'));
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
