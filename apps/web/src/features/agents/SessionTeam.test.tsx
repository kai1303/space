import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionTeam } from './SessionTeam.js';

const live=vi.hoisted(()=>({refresh:undefined as (()=>unknown)|undefined,revoke:undefined as (()=>void)|undefined}));
vi.mock('../../shared/realtime/live-updates.js',()=>({
  subscribeUpdates:(_scope:string,_id:string,read:()=>unknown,deny:()=>void)=>{live.refresh=read;live.revoke=deny;void read();return ()=>{};},
  invalidateUpdates:async()=>{await live.refresh?.();},
}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
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
