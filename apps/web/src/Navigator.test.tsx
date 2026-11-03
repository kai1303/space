import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { NavigatorSuggestions, NavigatorSettings } from './Navigator.js';
import { request } from './chat-client.js';
vi.mock('./chat-client.js',()=>({request:vi.fn()}));
const candidate={installation_id:'agent-1',name:'Writer',skill:'writing.draft',description:'Draft text'};
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};});
beforeEach(()=>vi.resetAllMocks());
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
  vi.mocked(request).mockImplementation(async(_path,body)=>body??{can_manage:true,settings:{mode:'rules',rules:[],daily_token_limit:10000,cooldown_seconds:300},candidates:[candidate]});
  render(<NavigatorSettings channel="c1" onCandidates={()=>{}} />);
  fireEvent.click(screen.getByRole('button',{name:'Navigator settings'}));
  expect((await screen.findByLabelText('Navigation mode') as HTMLSelectElement).value).toBe('rules');
  fireEvent.change(screen.getByLabelText('Navigation mode'),{target:{value:'semantic'}});
  fireEvent.click(screen.getByRole('button',{name:'Save Navigator settings'}));
  await waitFor(()=>expect(vi.mocked(request).mock.calls.some(c=>c[0]==='/channels/c1/navigator'&&(c[1] as any)?.mode==='semantic')).toBe(true));
 });
});
