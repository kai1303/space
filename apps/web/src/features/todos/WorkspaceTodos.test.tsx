import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceTodos } from './WorkspaceTodos.js';
const live = vi.hoisted(() => ({ refresh: undefined as undefined | (() => Promise<void>), revoke: undefined as undefined | (() => void) }));
vi.mock('../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: (_s: string, _id: string, refresh: () => Promise<void>, revoke: () => void) => { live.refresh = refresh; live.revoke = revoke; void refresh(); return () => {}; } }));
vi.mock('@space/ui/composer', async importOriginal => {
  const ui = await importOriginal<typeof import('@space/ui/composer')>();
  return { ...ui, RichComposer: ({ defaultValue, onSend, submitLabel }: any) => <form onSubmit={e => { e.preventDefault(); const text = new FormData(e.currentTarget).get('text') as string; void onSend(text, {ops:[{insert:text+'\n'}]}).catch(() => {}); }}><textarea name="text" aria-label="To-do text" defaultValue={defaultValue?.ops.map((op: any) => op.insert).join('').trim()}/><button>{submitLabel}</button></form> };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const todo = { id:'one', title:'Review proposal', completed:false, document:null, remind_at:null, reminder_fired_at:null, channel_id:null, message_id:null, archived:false, deleted:false, created_at:'2026-11-04T00:00:00Z', updated_at:'2026-11-04T00:00:00Z' };
it('identifies imported tasks and links to the external source',async()=>{
  fake(()=>({items:[{...todo,external:{name:'Issue tracker',external_id:'ISSUE-123',revision:'1',url:'https://issues.example.com/ISSUE-123'}}],next_cursor:null}));
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);
  await userEvent.click(await screen.findByRole('button',{name:'Review proposal'}));
  expect(screen.getByRole('link',{name:'View in Issue tracker'}).getAttribute('href')).toBe('https://issues.example.com/ISSUE-123');
  expect(screen.getByText('Text and completion follow updates from Issue tracker.')).toBeTruthy();
});
function fake(handler: (path:string, init?:RequestInit) => unknown) { vi.stubGlobal('fetch',vi.fn(async (path:string,init?:RequestInit) => ({ok:true,status:200,json:async()=>handler(path,init)}))); }
it('opens the right-pane composer and retries uncertain creates with one ID', async () => {
  const ids:string[]=[]; let fail=true;
  vi.stubGlobal('fetch',vi.fn(async (path:string,init?:RequestInit) => { if(init?.method==='POST'){ids.push(path); if(fail)throw new Error('connection lost'); return {ok:true,status:200,json:async()=>({...todo,...JSON.parse(String(init.body))})};} return {ok:true,status:200,json:async()=>path.includes('/todos/one')?todo:{items:[],next_cursor:null}}; }));
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);
  await screen.findByText('No to-dos yet'); await userEvent.click(screen.getAllByRole('button',{name:'Add To-do'})[0]!);
  await userEvent.type(screen.getByLabelText('To-do text'),'Review proposal'); await userEvent.click(screen.getByRole('button',{name:'Add to-do'}));
  await screen.findByRole('alert'); fail=false; await userEvent.click(screen.getByRole('button',{name:'Add to-do'}));
  await waitFor(()=>expect(ids).toHaveLength(2)); expect(ids[0]).toBe(ids[1]);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls.find(([,init])=>init?.method==='POST')![1]!.body))).toMatchObject({create_only:true,document:{ops:[{insert:'Review proposal\n'}]}});
});
it('changes filters and sorting on the server rather than only filtering the loaded page',async()=>{
  fake(()=>({items:[todo],next_cursor:'older'})); render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);
  await screen.findByRole('button',{name:'Review proposal'}); await userEvent.click(screen.getByRole('button',{name:'Filter'}));
  await userEvent.click(screen.getByLabelText('To-do status')); await userEvent.click(await screen.findByRole('option', { name: 'Completed', exact: true }));
  await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([path])=>String(path).includes('status=completed'))).toBe(true));
  await userEvent.click(screen.getByRole('button',{name:'Sort'})); await userEvent.click(screen.getByRole('menuitem',{name:'Latest date created'}));
  await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([path])=>String(path).includes('sort=newest'))).toBe(true));
});
it('completes with a partial update and clears private data on revocation',async()=>{
  let item=todo; fake((_path,init)=>{if(init?.method==='POST'){item={...item,...JSON.parse(String(init.body))};return item;}return {items:[item],next_cursor:null};});
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>); await userEvent.click(await screen.findByLabelText('Mark Review proposal complete'));
  expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.body==='{"completed":true}')).toBe(true);
  act(()=>live.revoke!()); expect(screen.queryByRole('button',{name:'Review proposal'})).toBeNull();
});
it('shows fired reminders and opens the authorized source message',async()=>{
  fake(()=>({items:[{...todo,remind_at:'2026-11-03T00:00:00Z',reminder_fired_at:'2026-11-03T00:00:00Z',channel_id:'c',message_id:'m'}],next_cursor:null}));
  const open=vi.fn();render(<WorkspaceTodos workspace="w" onOpen={open}/>);
  await userEvent.click(await screen.findByRole('button',{name:'Review proposal'})); await userEvent.click(screen.getByRole('button',{name:'View message'}));
  expect(open).toHaveBeenCalledWith({channel_id:'c',message_id:'m'}); expect(screen.getAllByText(/Reminder due/).length).toBeGreaterThan(0);
});
it('never restores a saved private to-do when access is revoked during its refresh',async()=>{
  let afterWrite=false, release:(value:unknown)=>void=()=>{};
  fake((_path,init)=>{if(init?.method==='POST'){afterWrite=true;return {...todo,completed:true};}return afterWrite?new Promise(resolve=>{release=resolve;}):{items:[todo],next_cursor:null};});
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);await userEvent.click(await screen.findByLabelText('Mark Review proposal complete'));
  act(()=>live.revoke!());await act(async()=>{release({items:[{...todo,completed:true}],next_cursor:null});});
  expect(screen.queryByText('Review proposal')).toBeNull();expect(screen.getByRole('alert').textContent).toContain('no longer have access');
});
it('keeps an off-page selected to-do fresh through its authorized detail endpoint',async()=>{
  const pageTwo={...todo,id:'two',title:'Page two task'};let item=pageTwo;
  fake((path,init)=>{if(init?.method==='POST'){item={...item,...JSON.parse(String(init.body))};return item;}if(path.endsWith('/two'))return item;if(path.includes('after=older'))return {items:[item],next_cursor:null};return {items:[todo],next_cursor:'older'};});
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);await userEvent.click(await screen.findByRole('button',{name:'Load more'}));await userEvent.click(await screen.findByRole('button',{name:'Page two task'}));
  await userEvent.click(screen.getByRole('button',{name:'Edit'}));await userEvent.clear(screen.getByLabelText('To-do text'));await userEvent.type(screen.getByLabelText('To-do text'),'Edited page two');await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
  await screen.findByRole('button',{name:'Edited page two'});await act(async()=>{await live.refresh!();});expect(screen.getByRole('button',{name:'Edited page two'})).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.body&&JSON.parse(String(init.body)).expected_updated_at===todo.updated_at)).toBe(true);
});
it('does not discard an edit draft when the server rejects a stale revision',async()=>{
  vi.stubGlobal('fetch',vi.fn(async (_path:string,init?:RequestInit)=>({ok:init?.method!=='POST',status:init?.method==='POST'?409:200,json:async()=>init?.method==='POST'?{error:'todo_conflict'}:{items:[todo],next_cursor:null}})));
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);await userEvent.click(await screen.findByRole('button',{name:'Review proposal'}));await userEvent.click(screen.getByRole('button',{name:'Edit'}));await userEvent.type(screen.getByLabelText('To-do text'),' changed');await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
  await screen.findByRole('alert');expect((screen.getByLabelText('To-do text') as HTMLTextAreaElement).value).toBe('Review proposal changed');
});
it('ignores a delayed detail result after the user selects another to-do',async()=>{
  let refreshing=false, release:(value:unknown)=>void=()=>{};
  const other={...todo,id:'other',title:'Other task'};
  fake(path=>path.endsWith('/one')?new Promise(resolve=>{release=resolve;}):{items:refreshing?[other]:[todo,other],next_cursor:null});
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);await userEvent.click(await screen.findByRole('button',{name:'Review proposal'}));refreshing=true;let pending:Promise<void>;
  await act(async()=>{pending=live.refresh!();await Promise.resolve();});await userEvent.click(screen.getByRole('button',{name:'Other task'}));await act(async()=>{release(todo);await pending!;});
  expect(screen.getByRole('complementary',{name:'To-do details'}).textContent).toContain('Other task');expect(screen.getByRole('complementary',{name:'To-do details'}).textContent).not.toContain('Review proposal');
});
it('removes deleted source messages through an explicit bounded cleanup action',async()=>{
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(){this.open=true;}});
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(){this.open=false;}});
  fake((_path,init)=>init?.method==='POST'?{items:[todo],next_cursor:'batch-two'}:{items:[todo],next_cursor:null});
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);await screen.findByRole('button',{name:'Review proposal'});
  await userEvent.click(screen.getByRole('button',{name:'Clean up'}));await userEvent.click(screen.getByRole('menuitem',{name:'Remove deleted messages'}));await userEvent.click(screen.getByRole('button',{name:'Confirm'}));
  await screen.findByRole('button',{name:'Continue cleanup'});
  expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.body==='{"action":"remove_deleted","scope":"all"}')).toBe(true);
  await userEvent.click(screen.getByRole('button',{name:'Continue cleanup'}));await userEvent.click(screen.getByRole('button',{name:'Confirm'}));
  await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.body==='{"action":"remove_deleted","scope":"all","after":"batch-two"}')).toBe(true));
});

it('submits the visible custom reminder time, including browser autofill',async()=>{
  let item=todo;fake((_path,init)=>{if(init?.method==='POST'){item={...item,...JSON.parse(String(init.body))};return item;}return {items:[item],next_cursor:null};});
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);await userEvent.click(await screen.findByRole('button',{name:'Review proposal'}));await userEvent.click(screen.getByRole('button',{name:'Add reminder'}));await userEvent.click(screen.getByRole('menuitem',{name:'Custom…'}));
  const input=screen.getByLabelText('Reminder date and time') as HTMLInputElement;
  input.value='2026-11-04T16:00';fireEvent.submit(input.form!);
  await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([,init])=>init?.body===JSON.stringify({remind_at:new Date('2026-11-04T16:00').toISOString()}))).toBe(true));
});
it('does not restore private write results when the refresh itself rejects access',async()=>{
  let written=false;
  vi.stubGlobal('fetch',vi.fn(async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){written=true;return {ok:true,status:200,json:async()=>({...todo,completed:true})};}return {ok:!written,status:written?403:200,json:async()=>written?{error:'forbidden'}:{items:[todo],next_cursor:null}};}));
  render(<WorkspaceTodos workspace="w" onOpen={()=>{}}/>);await userEvent.click(await screen.findByRole('button',{name:'Review proposal'}));await userEvent.click(screen.getByLabelText('Mark Review proposal complete'));
  await screen.findByRole('alert');expect(screen.queryByText('Review proposal')).toBeNull();expect(screen.queryByLabelText('In-progress')).toBeNull();
});
