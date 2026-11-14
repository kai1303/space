import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {SessionDiscovery} from './SessionDiscovery.js';

const mocks=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../../shared/api/request.js',()=>({request:mocks.read}));
vi.mock('../../shared/realtime/live-updates.js',()=>({
  subscribeUpdates:(_scope:string,_id:string,refresh:()=>unknown)=>{void refresh();return ()=>{};},invalidateUpdates:vi.fn(),
}));
afterEach(()=>{cleanup();mocks.read.mockReset();});
it('opens a source session inside the workspace and routes reviewer-only matches to the review room',async()=>{
  const id='d15c0ffe-0000-4000-a000-000000000001', second='d15c0ffe-0000-4000-a000-000000000002';
  const source={id,access:'source',origin_thread_id:'t',channel_id:'c',channel_archived:false,title:'Ship regression fix',status:'needs_attention',agent_name:'Claude',channel_name:'general'};
  mocks.read.mockImplementation(async(url:string)=>url.includes('q=regression')
    ? {items:[source],next_cursor:null} : {items:[{access:'reviewer',title:'Review prototype',id:second},source],next_cursor:null});
  const onOpen=vi.fn();
  render(<SessionDiscovery workspace="w" viewer="m" onOpen={onOpen}/>);
  expect((await screen.findByText('Review prototype')).closest('a')?.getAttribute('href')).toBe('/review/'+second);
  fireEvent.click(screen.getByText('Ship regression fix'));
  expect(onOpen).toHaveBeenCalledWith(source);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'regression'}});
  fireEvent.change(screen.getByLabelText('Status'),{target:{value:'needs_attention'}});
  fireEvent.click(screen.getByRole('button',{name:'Search sessions'}));
  await waitFor(()=>expect(screen.queryByText('Review prototype')).toBeNull());
  expect(mocks.read.mock.calls.at(-1)?.[0]).toContain('q=regression&status=needs_attention');
  expect(await screen.findByText('Ship regression fix')).toBeTruthy();
});
