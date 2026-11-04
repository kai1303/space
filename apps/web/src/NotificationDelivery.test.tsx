import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useNotificationDelivery } from './Notifications.js';
const mock = vi.hoisted(() => ({ read: undefined as undefined | (() => Promise<void>), revoke: undefined as undefined | ((code:string)=>void), disconnect: undefined as undefined | (()=>void) }));
vi.mock('./live-updates.js',()=>({subscribeUpdates:(_s:string,_id:string,read:()=>Promise<void>,revoke:(code:string)=>void)=>{mock.read=read;mock.revoke=revoke;void read();return ()=>{};}}));
vi.mock('./socket-session.js',()=>({acquireRealtime:()=>({on:(_event:string,callback:()=>void)=>{mock.disconnect=callback;},release:vi.fn()})}));
const base={id:'10',kind:'direct_message',channel_id:'dm',channel_kind:'direct',channel_name:'Alex',message_id:'message',thread_id:'thread',author_name:'Alex',text:'Private message',emoji:null,created_at:new Date().toISOString(),read_at:null,silent:false};
function Fixture({channel}:{channel?:string}){return <span>{useNotificationDelivery('workspace',channel,()=>{})} unread</span>;}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
function browser(){const close=vi.fn();const desktop=Object.assign(vi.fn(function(){return {close};}),{permission:'granted',requestPermission:vi.fn()});vi.stubGlobal('Notification',desktop);return {desktop,close};}
it('skips old activity and uses only fresh authorized claim content for a private banner',async()=>{
 const {desktop,close}=browser();let id='10';
 const fetch=vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>path.endsWith('/claim')?{deliver:true,notification:{...base,id,text:'Fresh private text'},preview_enabled:false}:{items:[{...base,id}],latest_id:id,unread_count:1,next_cursor:null}}));vi.stubGlobal('fetch',fetch);
 render(<Fixture/>);await screen.findByText('1 unread');expect(desktop).not.toHaveBeenCalled();
 id='11';await act(()=>mock.read!());expect(desktop).toHaveBeenCalledWith('New activity in Space',expect.objectContaining({body:'Open Space to view your notification.'}));
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
