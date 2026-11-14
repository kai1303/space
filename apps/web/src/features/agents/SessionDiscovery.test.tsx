import {toast} from '@space/ui/primitives';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {SessionDiscovery} from './SessionDiscovery.js';

const mocks=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../../shared/api/request.js',()=>({request:mocks.read}));
vi.mock('../../shared/realtime/live-updates.js',()=>({
  subscribeUpdates:(_scope:string,_id:string,refresh:()=>unknown)=>{void refresh();return ()=>{};},invalidateUpdates:vi.fn(),
}));
beforeAll(()=>{
  HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
});
afterEach(()=>{cleanup();mocks.read.mockReset();vi.restoreAllMocks();});
it('opens a source session inside the workspace and routes reviewer-only matches to the review room',async()=>{
  const id='d15c0ffe-0000-4000-a000-000000000001', second='d15c0ffe-0000-4000-a000-000000000002';
  const source={id,access:'source',origin_thread_id:'t',channel_id:'c',channel_archived:false,title:'Ship regression fix',status:'needs_attention',agent_name:'Claude',channel_name:'general'};
  mocks.read.mockImplementation(async(url:string)=>url.includes('q=regression')
    ? {items:[source],next_cursor:null} : {items:[{access:'reviewer',title:'Review prototype',id:second},source],next_cursor:null});
  const onOpen=vi.fn();
  render(<SessionDiscovery workspace="w" viewer="m" onOpen={onOpen}/>);
  expect((await screen.findByText('Review prototype')).closest('a')?.getAttribute('href')).toBe('/review/'+second);
  expect(screen.queryByText('Needs attention')).toBeNull();
  fireEvent.click(screen.getByText('Ship regression fix'));
  expect(onOpen).toHaveBeenCalledWith(source);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'regression'}});
  fireEvent.change(screen.getByLabelText('Archive'),{target:{value:'false'}});
  fireEvent.click(screen.getByRole('button',{name:'Search sessions'}));
  await waitFor(()=>expect(screen.queryByText('Review prototype')).toBeNull());
  expect(mocks.read.mock.calls.at(-1)?.[0]).toContain('q=regression&archived=false');
  expect(await screen.findByText('Ship regression fix')).toBeTruthy();
});

it('creates an agent session for a selected conversation, reusing its identity on retry',async()=>{
  const onOpen=vi.fn();
  let creates=0;
  mocks.read.mockImplementation(async(url:string,body?:Record<string,string>)=>{
    if(url.includes('/discover?'))return {items:[],next_cursor:null};
    if(url.includes('/channels?'))return {items:[{id:'general',name:'general',joined:true}],next_cursor:null};
    if(url.endsWith('/project-picker'))return {selection:{name:'Space repository',project_token:'sealed-selection'}};
    if(url.endsWith('/navigator'))return {candidates:[{project_picker:true,installation_id:'codex',name:'Codex',skill:'codex.run',persistent_sessions:true}]};
    if(url.endsWith('/messages?limit=50'))return {messages:[{thread_id:'checkout',text:'Checkout failed'}]};
    if(url==='/threads/checkout/agent-sessions') {
      if(++creates===1)throw Error('network_error');
      return {id:body?.client_session_id,origin_thread_id:'checkout',agent_name:'Codex',code_channel:true};
    }
    throw Error('unexpected '+url);
  });
  render(<SessionDiscovery workspace="w" viewer="u" onOpen={onOpen}/>);
  fireEvent.click(screen.getByRole('tab',{name:'Explore'}));
  await waitFor(()=>expect(mocks.read.mock.calls.some(([url])=>url.endsWith('scope=workspace'))).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'New agent session'}));
  fireEvent.change(await screen.findByLabelText('Session name'),{target:{value:'Checkout fix'}});
  fireEvent.click(screen.getByRole('combobox',{name:'Source channel'}));
  fireEvent.click(await screen.findByRole('option',{name:'#general'}));
  fireEvent.click(await screen.findByRole('combobox',{name:'Source conversation'}));
  fireEvent.click(await screen.findByRole('option',{name:'Checkout failed'}));
  fireEvent.click(screen.getByRole('button',{name:'Choose project folder…'}));
  await screen.findByRole('button',{name:'Space repository'});
  fireEvent.click(screen.getByRole('button',{name:'Create agent session'}));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Create agent session'}));
  await waitFor(()=>expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({origin_thread_id:'checkout',channel_id:'general'})));
  const calls=mocks.read.mock.calls.filter(([url])=>url==='/threads/checkout/agent-sessions');
  const pick = mocks.read.mock.calls.find(([url])=>url.endsWith('/project-picker'));
  expect(calls[0]?.[1]).toMatchObject({client_session_id:pick?.[1].session_id,project_token:'sealed-selection'});
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[1]).toEqual(calls[1]?.[1]);
  expect(calls[0]?.[1]).toEqual(expect.objectContaining({title:'Checkout fix',installation_id:'codex',skill:'codex.run'}));
});

it('labels only archived sessions and restores them through the sidebar archive action',async()=>{
  const success=vi.spyOn(toast,'success');
  const id='d15c0ffe-0000-4000-a000-000000000003';
  mocks.read.mockResolvedValue({items:[{id,access:'source',title:'Archived project',sidebar_archived:true}],next_cursor:null});
  render(<SessionDiscovery workspace="w" viewer="owner"/>);
  expect(await screen.findByText('Archived',{selector:'span'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Unarchive session'}));
  await waitFor(()=>expect(mocks.read).toHaveBeenCalledWith('/agent-sessions/'+id+'/sidebar',{archived:false},undefined,'PATCH',undefined,'owner'));
  expect(success).toHaveBeenCalledWith('Session restored');
});
