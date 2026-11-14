import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,act} from '@testing-library/react';
import {SessionSharedResources} from './SessionSharedResources.js';

const mocks=vi.hoisted(()=>({read:vi.fn(),revoke:()=>{}}));
vi.mock('../../shared/api/request.js',()=>({request:mocks.read}));
vi.mock('../../shared/realtime/live-updates.js',()=>({subscribeUpdates:(_scope:string,_thread:string,read:()=>void,revoke:()=>void)=>{
  mocks.revoke=revoke;read();return ()=>{};
}}));
afterEach(()=>{cleanup();mocks.read.mockReset();});

it('pages human shares, links to authorized downloads and clears older links on revocation',async()=>{
  const file='0067d566-0000-4000-8000-000000000001';
  const source={id:'task:a',author:'Alex',created_at:'2026-11-14'};
  mocks.read.mockResolvedValueOnce({items:[{...source,files:[{id:file,name:'Release.txt'}],links:[]}],next_cursor:'task:abc'})
    .mockResolvedValueOnce({items:[{...source,files:[],links:['https://example.test/release','javascript:alert(1)']}],next_cursor:null});
  render(<SessionSharedResources session="s" thread="t" viewer="v"/>);
  expect((await screen.findByRole('link',{name:'Release.txt'})).getAttribute('href')).toBe('/v1/assets/'+file+'/download');
  fireEvent.click(screen.getByRole('button',{name:'Older shares'}));
  expect((await screen.findByRole('link',{name:'https://example.test/release'})).getAttribute('rel')).toContain('noreferrer');
  expect(screen.queryByRole('link',{name:/javascript/})).toBeNull();
  expect(mocks.read.mock.lastCall?.[0]).toBe('/agent-sessions/s/resources?before=task%3Aabc');
  act(()=>mocks.revoke());
  expect(screen.queryByRole('link')).toBeNull();
});
