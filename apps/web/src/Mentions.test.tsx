import {beforeAll,afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MentionInbox,MentionDetails} from './Mentions.js';
vi.mock('./live-updates.js',()=>({subscribeUpdates:(_scope:string,_id:string,read:()=>unknown)=>{void read();return()=>{};}}));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const item={id:'1',channel_id:'channel',channel_name:'general',message_id:'message',thread_id:'thread',text:'@Kai please review',author_name:'Jamie',created_at:'2026-11-03T00:00:00Z',read_at:null,silent:false};
it('loads unread mention activity, persists read state and opens its source',async()=>{
 const open=vi.fn(),fetcher=vi.fn(async(input:unknown)=>new Response(JSON.stringify(String(input).endsWith('/mention-settings')?{paused_until:null,broadcast_permission:'all',can_manage:false,general_channel_id:'channel',member_count:2}:String(input).endsWith('/read')?{read:true}:{items:[item],unread_count:1,next_cursor:null}),{status:200}));vi.stubGlobal('fetch',fetcher);
 render(<MentionInbox workspace="workspace" onOpen={open}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Mentions (1 unread)'}));
 await userEvent.click(await screen.findByRole('button',{name:/Jamie.*general/}));
 expect(open).toHaveBeenCalledWith(item);
 expect(fetcher.mock.calls.some(([path])=>String(path)==='/v1/workspaces/workspace/mentions/1/read')).toBe(true);
});
it('clears private activity when authorization is lost',async()=>{
 let denied=false;vi.stubGlobal('fetch',vi.fn(async(input:unknown)=>new Response(JSON.stringify(denied?{error:'not_found'}:String(input).endsWith('/mention-settings')?{paused_until:null,broadcast_permission:'all',can_manage:false,member_count:2}:{items:[item],unread_count:1,next_cursor:null}),{status:denied?404:200})));
 render(<MentionInbox workspace="workspace" onOpen={()=>{}}/>);await screen.findByRole('button',{name:'Mentions (1 unread)'});denied=true;
 await userEvent.click(screen.getByRole('button',{name:'Mentions (1 unread)'}));
 await screen.findByRole('alert');expect(screen.queryByText(item.text)).toBeNull();
});
it('resolves a profile by ID instead of trusting its old display label',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({kind:'user',id:'target',label:'Current name',detail:'Engineer',presence:'active'}),{status:200}));vi.stubGlobal('fetch',fetcher);
 render(<MentionDetails channel="channel" mention={{kind:'user',id:'target',label:'Old name'}} onClose={()=>{}}/>);
 expect(await screen.findByRole('heading',{name:'Current name'})).toBeTruthy();
 expect(fetcher.mock.calls[0]?.[0]).toBe('/v1/channels/channel/mentions/user/target');
});
it('handles malformed activity responses without crashing the workspace',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:200})));
 render(<MentionInbox workspace="workspace" onOpen={()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'Mentions'}));
 expect((await screen.findByRole('alert')).textContent).toContain('Invalid mention activity response');
});
