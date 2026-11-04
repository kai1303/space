import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Notifications, NotificationPreferences, ThreadNotificationToggle } from './Notifications.js';
const mock = vi.hoisted(() => ({ refresh: undefined as undefined | (() => Promise<void>), revoke: undefined as undefined | ((code:string)=>void) }));
vi.mock('./live-updates.js', () => ({ subscribeUpdates: (_scope: string, _id: string, read: () => Promise<void>, revoke:(code:string)=>void) => { mock.refresh = read; mock.revoke = revoke; void read(); return () => {}; } }));
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const item = { id:'12', kind:'direct_message' as const, channel_id:'dm',channel_name:'Alex',channel_kind:'direct' as const,message_id:'message',thread_id:'thread',author_name:'Alex',text:'Review the draft',emoji:null,created_at:'2026-11-04T00:00:00Z',read_at:null,silent:false };
const settings = { mode:'mentions' as const,desktop_enabled:false,preview_enabled:false,thread_replies:true,paused_until:null };
function fake(handler:(path:string, init?:RequestInit)=>unknown) { vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>({ok:true,status:200,json:async()=>handler(path,init)}))); }
it('filters Activity, opens its target and marks only the displayed watermark read',async()=>{
 fake((path,init)=>init?.method==='POST'||init?.method==='PATCH'?{read:true}:{items:[item],unread_count:2,next_cursor:null,latest_id:'15'});
 const open=vi.fn();render(<Notifications workspace="workspace" onOpen={open}/>);
 await screen.findByText(item.text);await userEvent.click(screen.getByRole('tab',{name:'DMs',exact:true}));
 await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([path])=>String(path).includes('kind=direct_message'))).toBe(true));
 await userEvent.click(screen.getByRole('checkbox',{name:'Unreads'}));
 await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([path])=>String(path).includes('unread=true'))).toBe(true));
 await userEvent.click(screen.getByRole('button',{name:/Open notification from Alex/}));expect(open).toHaveBeenCalledWith(item);
 await userEvent.click(screen.getByRole('button',{name:'Mark all as read'}));
 await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([path,init])=>String(path).endsWith('/notifications/read')&&init?.body==='{"through":"15"}')).toBe(true));
});
it('does not ask for desktop permission on mount and lets the user pause without removing activity',async()=>{
 const permission=vi.fn(async()=> 'denied');vi.stubGlobal('Notification',Object.assign(vi.fn(),{permission:'default',requestPermission:permission}));
 fake((_path,init)=>init?.method==='PATCH'?{...settings,...JSON.parse(String(init.body))}:settings);
 render(<NotificationPreferences workspace="workspace" onClose={()=>{}}/>);
 await screen.findByRole('button',{name:'Enable desktop alerts'});expect(permission).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'Pause for 1 hour'}));
 await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.method==='PATCH'&&JSON.parse(String(init.body)).paused_until)).toBe(true));
 await userEvent.click(screen.getByRole('button',{name:'Enable desktop alerts'}));
 await screen.findByText(/blocked.*browser/i);expect(permission).toHaveBeenCalledTimes(1);
});
it('does not replace a newer activity page with a stale response after a filter change',async()=>{
 let release:(value:unknown)=>void=()=>{};
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>path.includes('kind=reaction')?{items:[{...item,kind:'reaction',text:'A reaction arrived'}],unread_count:1,next_cursor:null,latest_id:'20'}:new Promise(resolve=>{release=resolve;})})));
 render(<Notifications workspace="workspace" onOpen={()=>{}}/>);
 await userEvent.click(screen.getByRole('tab',{name:'Reactions',exact:true}));await screen.findByText('A reaction arrived');
 release({items:[item],unread_count:1,next_cursor:null,latest_id:'12'});
 await waitFor(()=>expect(screen.queryByText(item.text)).toBeNull());
});
it('follows and unfollows a thread through persisted subscription state',async()=>{
 let following=false;fake((_path,init)=>{if(init?.method==='PATCH')following=JSON.parse(String(init.body)).following;return {following};});
 render(<ThreadNotificationToggle thread="thread"/>);
 await userEvent.click(await screen.findByRole('button',{name:'Follow thread'}));await screen.findByRole('button',{name:'Following thread'});
 expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.body==='{"following":true}')).toBe(true);
});

it('ignores a stale preferences read after a successful change and after revocation',async()=>{
 let pending=false,release:(value:unknown)=>void=()=>{};let stored={...settings};
 vi.stubGlobal('fetch',vi.fn(async(_path:string,init?:RequestInit)=>({ok:true,status:200,json:async()=>{if(init?.method==='PATCH'){stored={...stored,...JSON.parse(String(init.body))};return stored;}return pending?new Promise(resolve=>{release=resolve;}):stored;}})));
 render(<NotificationPreferences workspace="workspace" onClose={()=>{}}/>);
 const preview=await screen.findByRole('checkbox',{name:'Include sender and message preview in desktop alerts'});pending=true;let read:Promise<void>;
 await act(async()=>{read=mock.refresh!();await Promise.resolve();});
 await userEvent.click(preview);expect((preview as HTMLInputElement).checked).toBe(true);
 await act(async()=>{release(settings);await read!;});expect((preview as HTMLInputElement).checked).toBe(true);
 await act(async()=>{read=mock.refresh!();await Promise.resolve();});act(()=>mock.revoke!('not_found'));
 await act(async()=>{release(settings);await read!;});expect(screen.queryByRole('checkbox',{name:'Include sender and message preview in desktop alerts'})).toBeNull();
});
it('ignores a stale thread subscription read after follow succeeds',async()=>{
 let slow=false,following=false,release:(value:unknown)=>void=()=>{};
 vi.stubGlobal('fetch',vi.fn(async(_path:string,init?:RequestInit)=>({ok:true,status:200,json:async()=>{if(init?.method==='PATCH'){following=true;slow=false;return {following};}return slow?new Promise(resolve=>{release=resolve;}):{following};}})));
 render(<ThreadNotificationToggle thread="thread"/>);await screen.findByRole('button',{name:'Follow thread'});slow=true;let read:Promise<void>;
 await act(async()=>{read=mock.refresh!();await Promise.resolve();});await userEvent.click(screen.getByRole('button',{name:'Follow thread'}));
 await screen.findByRole('button',{name:'Following thread'});await act(async()=>{release({following:false});await read!;});expect(screen.getByRole('button',{name:'Following thread'})).toBeTruthy();
});

it('uses arrow Home and End keys with a single Activity tab stop',async()=>{
 fake(()=>({items:[],unread_count:0,next_cursor:null,latest_id:'0'}));
 render(<Notifications workspace="workspace" onOpen={()=>{}}/>);
 const all=await screen.findByRole('tab',{name:'All',exact:true});
 all.focus();await userEvent.keyboard('{ArrowRight}');
 const dms=screen.getByRole('tab',{name:'DMs',exact:true});
 expect(document.activeElement).toBe(dms);expect(dms.getAttribute('aria-selected')).toBe('true');
 expect(screen.getAllByRole('tab').filter(tab=>tab.tabIndex===0)).toHaveLength(1);
 await userEvent.keyboard('{End}');expect(document.activeElement).toBe(screen.getByRole('tab',{name:'Reactions',exact:true}));
 await userEvent.keyboard('{Home}');expect(document.activeElement).toBe(all);
});
