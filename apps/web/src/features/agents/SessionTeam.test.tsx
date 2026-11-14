import { toast } from '@space/ui/primitives';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionTeam } from './SessionTeam.js';

const live=vi.hoisted(()=>({refresh:undefined as (()=>unknown)|undefined,revoke:undefined as (()=>void)|undefined}));
vi.mock('../../shared/realtime/live-updates.js',()=>({
  subscribeUpdates:(_scope:string,_id:string,read:()=>unknown,deny:()=>void)=>{live.refresh=read;live.revoke=deny;void read();return ()=>{};},
  invalidateUpdates:async()=>{await live.refresh?.();},
}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('posts human discussion to the review room and clears shared content on revocation',async()=>{
  let comment='';
  const fetch=vi.fn(async(_path:string,init?:RequestInit)=>{
    if(init?.method==='POST') comment=JSON.parse(String(init.body)).text;
    return {ok:true,json:async()=>({title:'Shared task',workspace_id:'workspace',viewer_id:'reviewer',can_manage:false,writable:true,reviewers:[],shared:[],
      messages:comment?[{sequence:'1',author:'Sam',body:comment,created_at:'2026-01-01T00:00:00Z'}]:[],before:null})};
  });vi.stubGlobal('fetch',fetch);
  render(<SessionTeam id="task" viewer="reviewer" standalone/>);
  expect(await screen.findByRole('heading',{name:'Shared task'})).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.change(screen.getByRole('textbox',{name:'Message the team'}),{target:{value:'Please check this diff'}});
  await userEvent.click(screen.getByRole('button',{name:'Send comment'}));
  await waitFor(()=>expect(screen.getByRole('listitem').textContent).toContain('Please check this diff'));
  expect(fetch.mock.calls.filter(([,init])=>init?.method==='POST').map(([path])=>path)).toEqual(['/v1/agent-sessions/task/team/discussion']);
  act(()=>live.revoke?.());
  expect(screen.queryByText('Please check this diff')).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(/unavailable/);
});

it('keeps a draft and the current comments available during initial loading and pagination',async()=>{
  let finish!: (value:Response)=>void;
  vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
  const page={title:'Review notes',viewer_id:'viewer',workspace_id:'space',can_manage:true,writable:true,reviewers:[],shared:[],
    messages:[{sequence:'2',author:'Sam',body:'Current comment',created_at:'2026-01-01'}],before:'2'};
  render(<SessionTeam id="s" viewer="viewer" standalone/>);
  const input=screen.getByRole('textbox',{name:'Message the team'});
  await userEvent.type(input,'Reviewing the change');
  expect(screen.getByRole('button',{name:'Send comment'})).toHaveProperty('disabled',true);
  await act(async()=>finish(Response.json(page)));
  await userEvent.click(screen.getByRole('button',{name:'Earlier comments'}));
  expect(screen.getByText('Current comment')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Earlier comments'}).getAttribute('aria-busy')).toBe('true');
  expect(screen.getByRole('button',{name:'Send comment'})).toHaveProperty('disabled',false);
  expect(input).toHaveProperty('value','Reviewing the change');
  act(()=>live.revoke?.());
  await act(async()=>finish(Response.json(page)));
  expect(screen.queryByText('Current comment')).toBeNull();
  expect(screen.queryByRole('textbox',{name:'Message the team'})).toBeNull();
});

it.each([
  {manager:true, label:'Remove invitation', confirmation:'Reviewer invitation removed'},
  {manager:false, label:'Leave review', confirmation:'You left the review'},
])('confirms $label after the request succeeds',async({manager,label,confirmation})=>{
  const success=vi.spyOn(toast,'success');
  const viewer=manager?'owner':'sam';
  const team={workspace_id:'w',viewer_id:viewer,can_manage:manager,writable:false,reviewers:[{user_id:'sam',display_name:'Sam'}],shared:[],messages:[]};
  let removed=false;
  vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
    if(path.endsWith('/team/reviewers/sam') && init?.method==='DELETE') removed=true;
    return Response.json({...team,reviewers:removed?[]:team.reviewers});
  }));
  render(<SessionTeam id="session" viewer={viewer}/>);
  await userEvent.click(await screen.findByText('People and access 1'));
  await userEvent.click(screen.getByRole('button',{name:label}));
  expect(removed).toBe(true);
  expect(success).toHaveBeenCalledWith(confirmation);
});

it('keeps matching reviewer candidates usable while searching and clears results for an empty query',async()=>{
 let finish!:(value:Response)=>void;
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>path.includes('q=Jo')?new Promise<Response>(resolve=>{finish=resolve;}):Response.json(path.includes('/directory?')
  ?{items:[{user_id:'jo',display_name:'Jo Lee'},{user_id:'james',display_name:'James Lee'}]}
  :{title:'Review',viewer_id:'me',workspace_id:'w',can_manage:true,writable:true,reviewers:[],shared:[],messages:[],before:null})));
 render(<SessionTeam id="s" viewer="me" standalone/>);
 fireEvent.click(await screen.findByText(/People and access/));
 const search=screen.getByRole('searchbox',{name:'Invite a reviewer'});
 fireEvent.change(search,{target:{value:'J'}});
 await screen.findByText('James Lee');
 fireEvent.change(search,{target:{value:'Jo'}});
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 expect(screen.queryByText('James Lee')).toBeNull();
 expect(screen.getByRole('button',{name:'Invite'})).toHaveProperty('disabled',false);
 fireEvent.change(search,{target:{value:''}});
 await act(async()=>finish(Response.json({items:[{user_id:'jo',display_name:'Jo Lee'}]})));
 expect(screen.queryByText('Searching teammates…')).toBeNull();
 expect(screen.queryByRole('button',{name:'Invite'})).toBeNull();
});
