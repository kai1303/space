import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionSummary } from '@space/contracts';
import { SessionPins } from './SessionMessageActions.js';

vi.mock('../../shared/realtime/live-updates.js',()=>({
  subscribeUpdates:(_scope:string,_id:string,read:()=>unknown)=>{void read();return ()=>{};},
}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('replaces the first-page placeholder and keeps pins usable while loading the next page', async()=>{
  HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  HTMLDialogElement.prototype.close=function(){this.open=false;};
  let finish!:(value:Response)=>void;
  const pin={id:'pin',task_id:'turn',part:'response',excerpt:'Review notes'};
  vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
  const onOpen=vi.fn();
  render(<SessionPins session={{id:'session',origin_thread_id:'thread'} as AgentSessionSummary} viewer="me" onOpen={onOpen} onClose={()=>{}}/>);
  expect(screen.getByText('Loading pins…')).toBeTruthy();
  await act(async()=>finish(Response.json({items:[pin],next:'page-2'})));
  const more=screen.getByRole('button',{name:'More pinned messages'});
  fireEvent.click(more);
  expect(more.getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByText('Loading pins…')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Review notes'}));
  expect(onOpen).toHaveBeenCalledWith('turn','response');
  await act(async()=>finish(Response.json({items:[pin],next:'page-2'})));
  await act(async()=>finish(Response.json({items:[{...pin,id:'older',excerpt:'Earlier decision'}],next:null})));
  expect(screen.getByRole('button',{name:'Earlier decision'})).toBeTruthy();
});
