import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { WorkspaceQueryProvider } from '../../shared/realtime/workspace-query-cache.js';
import { ActivityPeek, useNotificationDelivery } from './Notifications.js';
const mock = vi.hoisted(() => ({ read: undefined as undefined | (() => Promise<void>), revoke: undefined as undefined | ((code:string)=>void), disconnect: undefined as undefined | (()=>void) }));
const version = vi.hoisted(() => ({}));
vi.mock('../../shared/realtime/live-updates.js',()=>({workspaceReadVersion: () => version, subscribeUpdates:(_s:string,_id:string,read:()=>Promise<void>,revoke:(code:string)=>void)=>{mock.read=read;mock.revoke=revoke;void read();return ()=>{};}}));
vi.mock('../../shared/realtime/socket-session.js',()=>({acquireRealtime:()=>({on:(_event:string,callback:()=>void)=>{mock.disconnect=callback;},release:vi.fn()})}));
const base={id:'10',kind:'direct_message',channel_id:'dm',channel_kind:'direct',channel_name:'Alex',message_id:'message',thread_id:'thread',author_name:'Alex',text:'Private message',emoji:null,created_at:new Date().toISOString(),read_at:null,silent:false};
function Fixture({channel}:{channel?:string}){return <span>{useNotificationDelivery('workspace',channel,()=>{})} unread</span>;}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
function browser(){const close=vi.fn();const desktop=Object.assign(vi.fn(function(){return {close};}),{permission:'granted',requestPermission:vi.fn()});vi.stubGlobal('Notification',desktop);return {desktop,close};}
it('skips old activity and uses only fresh authorized claim content for a private banner',async()=>{
 const {desktop,close}=browser();let id='10';
 const fetch=vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>path.endsWith('/claim')?{deliver:true,notification:{...base,id,text:'Fresh private text'},preview_enabled:false}:{items:[{...base,id}],latest_id:id,unread_count:1,next_cursor:null}}));vi.stubGlobal('fetch',fetch);
 render(<Fixture/>);await screen.findByText('1 unread');expect(desktop).not.toHaveBeenCalled();
 id='11';await act(()=>mock.read!());expect(desktop).toHaveBeenCalledWith('New activity in Space',expect.objectContaining({body:'Open Space to view your notification.',silent:true}));
 await act(()=>mock.read!());expect(desktop).toHaveBeenCalledTimes(1);
 act(()=>mock.revoke!('not_found'));expect(close).toHaveBeenCalled();expect(screen.getByText('0 unread')).toBeTruthy();
});
it('suppresses the focused conversation and reconnect backlog without claiming them',async()=>{
 const {desktop}=browser();vi.spyOn(document,'hasFocus').mockReturnValue(true);Object.defineProperty(document,'hidden',{configurable:true,value:false});let id='10';
 const fetch=vi.fn(async(_path:string)=>({ok:true,status:200,json:async()=>({items:[{...base,id}],latest_id:id,unread_count:1,next_cursor:null})}));vi.stubGlobal('fetch',fetch);
 render(<Fixture channel="dm"/>);await screen.findByText('1 unread');id='11';await act(()=>mock.read!());
 expect(fetch.mock.calls.some(([path])=>String(path).endsWith('/claim'))).toBe(false);
 act(()=>mock.disconnect!());id='12';await act(()=>mock.read!());expect(desktop).not.toHaveBeenCalled();
});
it('does not show an alert after teardown while a claim is pending',async()=>{
 const {desktop}=browser();let id='10',complete:(value:unknown)=>void=()=>{};
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>path.endsWith('/claim')?new Promise(resolve=>{complete=resolve;}):{items:[{...base,id}],latest_id:id,unread_count:1,next_cursor:null}})));
 const view=render(<Fixture/>);await screen.findByText('1 unread');id='11';let pending:Promise<void>;
 await act(async()=>{pending=mock.read!();await Promise.resolve();});view.unmount();
 await act(async()=>{complete({deliver:true,notification:{...base,id},preview_enabled:true});await pending!;});expect(desktop).not.toHaveBeenCalled();
});

it('can alert a lower ID committed late without replaying rows already seen',async()=>{
 const {desktop}=browser();let items=[{...base,id:'12'}];
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>path.endsWith('/claim')?{deliver:true,notification:{...base,id:'11'},preview_enabled:true}:{items,latest_id:'12',unread_count:items.length,next_cursor:null}})));
 render(<Fixture/>);await screen.findByText('1 unread');items=[...items,{...base,id:'11'}];await act(()=>mock.read!());
 expect(desktop).toHaveBeenCalledTimes(1);expect(desktop).toHaveBeenCalledWith('Alex · Alex',expect.objectContaining({tag:'space:workspace:11'}));
});

it('closes an already displayed private alert when channel access is revoked',async()=>{
 const {desktop,close}=browser();let items=[base];
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>path.endsWith('/claim')?{deliver:true,notification:{...base,id:'11'},preview_enabled:true}:{items,latest_id:items[0]?.id??'0',unread_count:items.length,next_cursor:null}})));
 render(<Fixture/>);await screen.findByText('1 unread');items=[{...base,id:'11'}];await act(()=>mock.read!());expect(desktop).toHaveBeenCalledTimes(1);
 items=[];await act(()=>mock.read!());expect(close).toHaveBeenCalledTimes(1);expect(screen.getByText('0 unread')).toBeTruthy();
});

it('chimes once for fresh authorized activity with desktop permission denied', async () => {
 const start = vi.fn(), close = vi.fn(async () => {});
 vi.stubGlobal('Notification', { permission:'denied' });
 vi.stubGlobal('AudioContext', class {
   state = 'running';
   currentTime = 0;
   close = close;
   createOscillator() { return {frequency:{value:0}, connect:vi.fn(), start, stop:vi.fn()}; }
   createGain() { return {gain:{setValueAtTime:vi.fn(), exponentialRampToValueAtTime:vi.fn()}, connect:vi.fn()}; }
 });
 let id = '10', enabled = true, granted = true;
 const fetch = vi.fn(async (path:string, init?:RequestInit) => ({
   ok:true, status:200, json:async () => {
     if (path.endsWith('/claim')) {
       expect(JSON.parse(String(init?.body))).toEqual({channel:'sound'});
       return {deliver:granted};
     }
     return {items:[{...base,id}],unread_count:1,latest_id:id,next_cursor:null,sound_enabled:enabled};
   }
 }));
 vi.stubGlobal('fetch', fetch);
 const view = render(<Fixture/>);
 await screen.findByText('1 unread');
 await userEvent.click(document.body);
 expect(start).not.toHaveBeenCalled();
 id = '11';
 await act(()=>mock.read!());
 await act(()=>mock.read!());
 expect(start).toHaveBeenCalledTimes(1);
 granted = false; id = '12';
 await act(()=>mock.read!());
 enabled = false; granted = true; id = '13';
 await act(()=>mock.read!());
 expect(start).toHaveBeenCalledTimes(1);
 expect(fetch.mock.calls.filter(([path])=>path.endsWith('/claim'))).toHaveLength(2);
 view.unmount();
 expect(close).toHaveBeenCalledTimes(1);
});

it('still shows the desktop banner if a sound claim fails', async () => {
 const { desktop } = browser();
 vi.stubGlobal('AudioContext', class { state = 'running'; close = async () => {}; });
 let id = '10';
 vi.stubGlobal('fetch', vi.fn(async (path:string, init?:RequestInit) => {
   if (path.endsWith('/claim') && init?.body === '{"channel":"sound"}') throw new Error('Network error');
   const data = path.endsWith('/claim') ? {deliver:true,notification:{...base,id}} :
     {items:[{...base,id}],unread_count:1,latest_id:id,next_cursor:null,sound_enabled:true};
   return {ok:true,status:200,json:async () => data};
 }));
 render(<Fixture/>);
 await screen.findByText('1 unread');
 await userEvent.click(document.body);
 id = '11';
 await act(() => mock.read!());
 expect(desktop).toHaveBeenCalledTimes(1);
});

it('reuses delivery’s authorized Activity page on first paint and discards it after a preview read receipt', async () => {
  let readAt: string | null = null;
  const transport = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === 'PATCH') readAt = base.created_at;
    const page = { items: [{ ...base, read_at: readAt }], unread_count: readAt ? 0 : 1, next_cursor: null, latest_id: base.id };
    return { ok: true, status: 200, json: async () => init.method === 'PATCH' ? { read: true } : page };
  });
  vi.stubGlobal('fetch', transport);
  function Preview() {
    const [shown, setShown] = useState(false);
    return <><Fixture/><button onClick={() => setShown(true)}>Show preview</button>
      {shown && <ActivityPeek workspace="workspace" onOpen={() => setShown(false)}/>}</>;
  }
  render(<WorkspaceQueryProvider workspace="workspace" viewer="user"><Preview/></WorkspaceQueryProvider>);
  await screen.findByText('1 unread');
  const show = screen.getByRole('button', { name: 'Show preview' });
  act(() => show.click());
  const first = screen.getByRole('button', { name: /Open notification from Alex/ });
  expect(first.closest('li')?.classList.contains('is-unread')).toBe(true);
  expect(transport.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(1);
  await userEvent.click(first);
  expect(screen.queryByRole('button', { name: /Open notification from Alex/ })).toBeNull();
  await userEvent.click(show);
  const next = await screen.findByRole('button', { name: /Open notification from Alex/ });
  expect(next.closest('li')?.classList.contains('is-unread')).toBe(false);
  expect(transport.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(2);
});
