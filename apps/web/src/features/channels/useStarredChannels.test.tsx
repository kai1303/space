import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useStarredChannels } from './useStarredChannels.js';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../shared/api/request.js',()=>({request:mocks.request}));
vi.mock('../../shared/realtime/live-updates.js',()=>{
  const readers=new Map<string,Set<()=>unknown>>();
  return {
    subscribeUpdates:(_scope:string,id:string,read:()=>unknown)=>{const group=readers.get(id)??new Set();readers.set(id,group);group.add(read);void read();return()=>{group.delete(read);};},
    invalidateUpdates:async(_scope:string,id:string)=>{await Promise.all([...readers.get(id)??[]].map(read=>read()));},
  };
});
afterEach(()=>{cleanup();mocks.request.mockReset();});
it('starts a fresh starred page when switching workspaces after pagination',async()=>{
  mocks.request.mockImplementation(async(path:string)=>({items:[],next_cursor:path.includes('after=')?null:'old-cursor'}));
  const {result,rerender}=renderHook(({workspace})=>useStarredChannels(workspace),{initialProps:{workspace:'one'}});
  await waitFor(()=>expect(result.current.next).toBe('old-cursor'));
  act(()=>result.current.loadMore());
  await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/workspaces/one/hub/starred?limit=100&after=old-cursor'));
  rerender({workspace:'two'});
  await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/workspaces/two/hub/starred?limit=100'));
  expect(mocks.request.mock.calls.some(([path])=>path.includes('/two/')&&path.includes('after='))).toBe(false);
});
it('uses exact selected-conversation state so a star beyond the sidebar page can be removed',async()=>{
  let active=true;
  mocks.request.mockImplementation(async(_path:string,body?:{active:boolean})=>{if(body)active=body.active;return {active};});
  const {result}=renderHook(()=>useStarredChannels('one','far-channel'));
  await waitFor(()=>expect(result.current.active).toBe(true));
  await act(async()=>result.current.toggle('far-channel'));
  expect(mocks.request).toHaveBeenCalledWith('/workspaces/one/hub/starred/far-channel',{active:false});
  expect(result.current.active).toBe(false);
});
it.each([true,false])('updates sibling views before confirmation and rolls back a failed save: success=%s',async success=>{
  let backend=false,finish!:(value?:unknown)=>void,fail!:(error:Error)=>void;
  const saved=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
  const conversation={id:'channel',name:'general',kind:'channel',private:false};
  mocks.request.mockImplementation(async(path:string,body?:{active:boolean})=>{
    if(body){await saved;backend=body.active;return {active:backend};}
    return path.endsWith('/channel')?{active:backend}:{items:backend?[conversation]:[],next_cursor:null};
  });
  const {result}=renderHook(()=>({header:useStarredChannels('one','channel'),sidebar:useStarredChannels('one'),otherUser:useStarredChannels('one',undefined,'other-user')}));
  await waitFor(()=>expect(mocks.request).toHaveBeenCalledTimes(3));
  let write!:Promise<unknown>;
  act(()=>{write=result.current.header.toggle('channel',conversation).catch(error=>error);});
  try {
    expect(result.current.header.active).toBe(true);
    expect(result.current.sidebar.ids).toEqual(['channel']);
    expect(result.current.otherUser.ids).toEqual([]);
  } finally {
    await act(async()=>{if(success)finish();else fail(new Error('save_failed'));await write;});
  }
  expect(result.current.header.active).toBe(success);
  expect(result.current.sidebar.ids).toEqual(success?['channel']:[]);
});
