import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
import { NavigatorSuggestions, NavigatorSettings } from './Navigator.js';
import { request } from '../../shared/api/request.js';
vi.mock('../../shared/api/request.js',()=>({request:vi.fn()}));
const updates = vi.hoisted(() => new Map<string, () => unknown>());
vi.mock('../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: (scope: string, id: string, refresh: () => unknown) => { updates.set(`${scope}:${id}`, refresh); void refresh(); return () => updates.delete(`${scope}:${id}`); } }));
const candidate={installation_id:'agent-1',name:'Writer',skill:'writing.draft',description:'Draft text'};
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){if(this.open){this.open=false;this.dispatchEvent(new Event('close'));}};});
beforeEach(()=>vi.resetAllMocks());
afterEach(cleanup);
describe('Navigator in a thread',()=>{
 it('shows a suggestion and starts only the chosen agent on explicit click',async()=>{
  vi.mocked(request).mockImplementation(async path=>path.includes('/accept')?{id:'task-1'}:[{id:'suggestion-1',thread_id:'thread-1',decision:{action:'suggest',reason:'Writer can draft this',tasks:[]},candidates:[candidate]}]);
  render(<NavigatorSuggestions channel="channel-1" thread="thread-1" />);
  expect(await screen.findByText('Writer can draft this')).toBeTruthy();
  expect(vi.mocked(request).mock.calls.some(c=>c[0].includes('/accept'))).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Ask Writer · writing.draft'}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith('/navigator/suggestions/suggestion-1/accept',{installation_id:'agent-1',skill:'writing.draft'}));
 });
 it('hides a dismissed suggestion and preserves visible retry errors',async()=>{
  vi.mocked(request).mockResolvedValueOnce([{id:'s1',decision:{reason:'Can help'},candidates:[candidate]}]).mockRejectedValueOnce(new Error('not_found'));
  render(<NavigatorSuggestions channel="c1" thread="t1" />);await screen.findByText('Can help');fireEvent.click(screen.getByRole('button',{name:'Dismiss suggestion'}));
  expect((await screen.findByRole('alert')).textContent).toContain('not found');
 });
 it('defaults to rules and requires manager action before semantic navigation',async()=>{
  vi.mocked(request).mockImplementation(async(path,body)=>path.endsWith('/observations')?[]:body??{can_manage:true,settings:{mode:'rules',rules:[],daily_token_limit:10000,cooldown_seconds:300},candidates:[candidate]});
  render(<NavigatorSettings channel="c1" onCandidates={()=>{}} />);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  expect((await screen.findByLabelText('Navigation mode')).textContent).toBe('Rules only · no model calls');
  await userEvent.click(screen.getByLabelText('Navigation mode')); await userEvent.click(screen.getByRole('option', { name: 'Rules + optional model providers' }));
  fireEvent.click(screen.getByRole('button',{name:'Save Navigator settings'}));
  await waitFor(()=>expect(vi.mocked(request).mock.calls.some(c=>c[0]==='/channels/c1/navigator'&&(c[1] as any)?.mode==='semantic')).toBe(true));
 });
});

describe('Navigator observation settings', () => {
 const configuration = {can_manage:true,settings:{mode:'rules',rules:[],daily_token_limit:10000,cooldown_seconds:300},candidates:[candidate]};
 const onCandidates = vi.fn();
 const observation = {id:'o1',thread_id:'t1',decision:{action:'continue',reason:'Continue drafting',delivery_error:'agent_unavailable'},created_at:'2026-11-06T10:00:00Z'};

 it('defaults older settings to suggest and saves observe mode explicitly', async () => {
  vi.mocked(request).mockImplementation(async(path,body)=>path.endsWith('/observations')?[]:body??configuration);
  render(<NavigatorSettings channel="c1" onCandidates={onCandidates} />);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  expect((await screen.findByLabelText('Action mode')).textContent).toBe('Suggest and route follow-ups');
  await userEvent.click(screen.getByLabelText('Action mode'));
  await userEvent.click(screen.getByRole('option',{name:'Observe'}));
  expect(screen.getByText(/Observe records proposed suggestions, follow-ups, and stops without doing them/)).toBeTruthy();
  expect(screen.getByText(/Explicit mentions still start requests/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Save Navigator settings'}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith('/channels/c1/navigator',expect.objectContaining({execution_mode:'observe'}),undefined,'PATCH'));
 });

 it('loads manager review on open and refreshes only on explicit request', async () => {
  let observations = [observation];
  vi.mocked(request).mockImplementation(async path=>path.endsWith('/observations')?observations:configuration);
  render(<NavigatorSettings channel="c1" onCandidates={onCandidates} />);
  await waitFor(()=>expect(onCandidates).toHaveBeenCalledWith([candidate]));
  expect(vi.mocked(request).mock.calls.filter(c=>c[0].endsWith('/observations'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  expect(await screen.findByText('Continue drafting')).toBeTruthy();
  expect(screen.getByText('Follow-up')).toBeTruthy();
  expect(screen.getByText('Delivery error: agent unavailable')).toBeTruthy();
  expect(document.querySelector('time')?.dateTime).toBe(observation.created_at);
  observations = [{...observation,decision:{...observation.decision,reason:'Updated observation'}}];
  fireEvent.click(screen.getByRole('button',{name:'Refresh observations'}));
  expect(await screen.findByText('Updated observation')).toBeTruthy();
  expect(vi.mocked(request).mock.calls.filter(c=>c[0].endsWith('/observations'))).toHaveLength(2);
 });

 it('keeps review errors separate from editable settings', async () => {
  vi.mocked(request).mockImplementation(async path=>{if(path.endsWith('/observations'))throw new Error('review_unavailable');return configuration;});
  render(<NavigatorSettings channel="c1" onCandidates={onCandidates} />);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  expect((await screen.findByRole('alert')).textContent).toContain('review unavailable');
  expect(screen.getByLabelText('Action mode')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Save Navigator settings'})).toBeTruthy();
 });

 it('does not let a read-only viewer change action mode or request review', async () => {
  vi.mocked(request).mockResolvedValue({...configuration,can_manage:false});
  render(<NavigatorSettings channel="c1" onCandidates={onCandidates} />);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  expect((await screen.findByLabelText('Action mode')).getAttribute('disabled')).not.toBeNull();
  expect(screen.queryByRole('button',{name:'Save Navigator settings'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Refresh observations'})).toBeNull();
  expect(vi.mocked(request).mock.calls.some(c=>c[0].endsWith('/observations'))).toBe(false);
 });

 it('ignores old-channel observations after switching to a read-only channel', async () => {
  let resolveOld!: (value: unknown) => void;
  vi.mocked(request).mockImplementation(async path=>path==='/channels/c1/navigator/observations'?new Promise(resolve=>{resolveOld=resolve;}):{...configuration,can_manage:path.includes('/c1/')});
  const view = render(<NavigatorSettings channel="c1" onCandidates={onCandidates} />);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  await waitFor(()=>expect(resolveOld).toBeTypeOf('function'));
  view.rerender(<NavigatorSettings channel="c2" onCandidates={onCandidates} />);
  await screen.findByText('A channel manager can change these settings.');
  await act(async()=>resolveOld([observation]));
  expect(screen.queryByText('Continue drafting')).toBeNull();
  expect(vi.mocked(request).mock.calls.some(c=>c[0]==='/channels/c2/navigator/observations')).toBe(false);
 });

 it('ignores a review response from a closed dialog after reopening', async () => {
  let resolveOld!: (value: unknown) => void;
  let observationRequests = 0;
  vi.mocked(request).mockImplementation(async path=>{
   if(!path.endsWith('/observations'))return configuration;
   return ++observationRequests===1?new Promise(resolve=>{resolveOld=resolve;}):[{...observation,decision:{...observation.decision,reason:'Current observation'}}];
  });
  render(<NavigatorSettings channel="c1" onCandidates={onCandidates} />);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  await waitFor(()=>expect(resolveOld).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button',{name:'Close dialog'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  await screen.findByText('Current observation');
  await act(async()=>resolveOld([observation]));
  expect(screen.queryByText('Continue drafting')).toBeNull();
  expect(screen.getByText('Current observation')).toBeTruthy();
 });

 it('keeps a newer draft when an earlier save finishes, including after a settings retry',async()=>{
  let finish!: (value:unknown)=>void;
  vi.mocked(request).mockRejectedValueOnce(new Error('unavailable')).mockImplementation(async(path,body)=>
   body ? new Promise(resolve=>{finish=resolve;}) : path.endsWith('/observations') ? [] : configuration);
  render(<NavigatorSettings channel="c1" onCandidates={onCandidates}/>);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  fireEvent.click(await screen.findByRole('button',{name:'Retry settings'}));
  fireEvent.click(await screen.findByRole('button',{name:'Save Navigator settings'}));
  fireEvent.change(screen.getByLabelText('Capability rules'),{target:{value:'review: draft'}});
  await act(async()=>finish(configuration.settings));
  expect(screen.getByLabelText('Capability rules')).toHaveProperty('value','review: draft');
  expect(screen.getByRole('button',{name:'Save Navigator settings'})).toHaveProperty('disabled',false);
 });

 it('does not apply an old-channel save to the current settings dialog', async () => {
  let resolveSave!: (value: unknown) => void;
  vi.mocked(request).mockImplementation(async(path,body)=>{
   if(body)return new Promise(resolve=>{resolveSave=resolve;});
   return path.endsWith('/observations')?[]:{...configuration,settings:{...configuration.settings,execution_mode:path.includes('/c2/')?'observe':'suggest'}};
  });
  const view = render(<NavigatorSettings channel="c1" onCandidates={onCandidates} />);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  fireEvent.click(await screen.findByRole('button',{name:'Save Navigator settings'}));
  await waitFor(()=>expect(resolveSave).toBeTypeOf('function'));
  view.rerender(<NavigatorSettings channel="c2" onCandidates={onCandidates} />);
  await waitFor(()=>expect(screen.getByLabelText('Action mode').textContent).toBe('Observe'));
  await act(async()=>resolveSave({...configuration.settings,execution_mode:'suggest'}));
  expect(screen.getByLabelText('Action mode').textContent).toBe('Observe');
  expect(screen.getByRole('button',{name:'Save Navigator settings'})).toBeTruthy();
 });
});

it('refreshes suggestions when the channel socket reports a committed change', async () => {
 let reason = 'First suggestion';
 vi.mocked(request).mockImplementation(async () => [{id:'s1',thread_id:'t1',decision:{reason},candidates:[candidate]}]);
 render(<NavigatorSuggestions channel="live-channel" />);
 await screen.findByText('First suggestion');
 reason = 'Updated suggestion';
 await updates.get('channel:live-channel')?.();
 expect(await screen.findByText('Updated suggestion')).toBeTruthy();
});
