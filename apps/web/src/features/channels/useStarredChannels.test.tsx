import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useStarredChannels } from './useStarredChannels.js';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../shared/api/request.js',()=>({request:mocks.request}));
vi.mock('../../shared/realtime/live-updates.js',()=>({subscribeUpdates:(_scope:string,_id:string,read:()=>unknown)=>{void read();return()=>{};}}));
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
