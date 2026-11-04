import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,renderHook} from '@testing-library/react';
import type {AgentSessionDetail,AgentSessionTurn} from '@space/contracts';
import {mergeSessionHistory,receiveSessionHistory,SESSION_HISTORY_LIMIT,useAgentSessionHistory} from './useAgentSessionHistory.js';
const turn=(id:number,revision=1)=>({task:{id:String(id),revision},created_at:new Date(id*1000).toISOString()} as AgentSessionTurn);
const page=(from:number,to:number)=>({session:{id:'session'},turns:Array.from({length:to-from+1},(_,i)=>turn(from+i)),next_cursor:from>1?String(from):null,has_newer:false} as AgentSessionDetail);
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('bounds older and newer history like DMs and retains both navigation edges',()=>{
 const current={...page(101,350),has_newer:false};
 const older=mergeSessionHistory(current,page(81,100),'older');
 expect(older.turns).toHaveLength(SESSION_HISTORY_LIMIT);
 expect(older.turns[0]!.task.id).toBe('81');expect(older.turns.at(-1)!.task.id).toBe('330');
 expect(older.next_cursor).toBe('81');expect(older.has_newer).toBe(true);
 const newer=mergeSessionHistory(older,page(331,350),'newer');
 expect(newer.turns[0]!.task.id).toBe('101');expect(newer.turns.at(-1)!.task.id).toBe('350');
 expect(newer.has_newer).toBe(false);
});
it('does not stitch a missing middle into older history during reconnect',()=>{
 const current={...page(1,20),has_newer:false};
 const reading=receiveSessionHistory(current,page(41,60),false);
 expect(reading.turns.map(t=>t.task.id)).toEqual(current.turns.map(t=>t.task.id));
 expect(reading.has_newer).toBe(true);
 const latest=receiveSessionHistory(current,page(41,60),true);
 expect(latest.turns[0]!.task.id).toBe('41');expect(latest.has_newer).toBe(false);
});
it('keeps newer task revisions when an older page completes late',()=>{
 const current={...page(10,20),has_newer:false};current.turns[0]=turn(10,4);
 expect(mergeSessionHistory(current,page(1,10),'older').turns.find(t=>t.task.id==='10')!.task.revision).toBe(4);
});
it('uses the initial snapshot without refetching and ignores an older request superseded by jump to latest',async()=>{
 let finishOlder!:(value:unknown)=>void;
 const fetch=vi.fn(async(path:string)=>path.includes('before=')?new Promise(resolve=>{finishOlder=resolve;}):{ok:true,json:async()=>page(41,60)});
 vi.stubGlobal('fetch',fetch);
 const initial=page(21,40),pinned={current:true};
 const {result}=renderHook(()=>useAgentSessionHistory(initial,pinned,()=>{}));
 expect(fetch).not.toHaveBeenCalled();
 let old!:Promise<unknown>;
 act(()=>{old=result.current.load('older');void result.current.load('older');});
 expect(fetch).toHaveBeenCalledTimes(1);
 await act(async()=>{await result.current.load('latest');});
 await act(async()=>{finishOlder({ok:true,json:async()=>page(1,20)});await old;});
 expect(result.current.data.turns[0]!.task.id).toBe('41');
 expect(result.current.loading).toBeNull();
});
it('keeps pagination when an empty session gains more than one page',()=>{
 const empty={...page(1,0),has_newer:false};
 const updated=receiveSessionHistory(empty,page(21,40),true);
 expect(updated.next_cursor).toBe('21');expect(updated.turns).toHaveLength(20);
});
it('uses a newer live snapshot when a latest-page request finishes late',async()=>{
 let finish!:(value:unknown)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve;})));
 const pinned={current:true},initial=page(1,20);
 const {result,rerender}=renderHook(({snapshot})=>useAgentSessionHistory(snapshot,pinned,()=>{}),{initialProps:{snapshot:initial}});
 let pending!:Promise<unknown>;act(()=>{pending=result.current.load('latest');});
 rerender({snapshot:page(21,40)});
 await act(async()=>{finish({ok:true,json:async()=>page(1,20)});await pending;});
 expect(result.current.data.turns.at(-1)!.task.id).toBe('40');
 expect(result.current.latest.turns.at(-1)!.task.id).toBe('40');
 expect(result.current.data.has_newer).toBe(false);
});
it('ignores late responses after unmounting, including access errors',async()=>{
 let fail!:(reason:unknown)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise((_resolve,reject)=>{fail=reject;})));
 const error=vi.fn(),initial=page(21,40),pinned={current:true};
 const {result,unmount}=renderHook(()=>useAgentSessionHistory(initial,pinned,error));
 let pending!:Promise<unknown>;act(()=>{pending=result.current.load('older');});
 unmount();await act(async()=>{fail(new Error('not_found'));await pending;});
 expect(error).not.toHaveBeenCalled();
});
