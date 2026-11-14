import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSidekick } from './BrowserSidekick.js';
import { request } from '../../shared/api/request.js';

vi.mock('../../shared/api/request.js', () => ({request:vi.fn()}));
vi.mock('./AgentSessions.js', () => ({AgentSessions:({initialSessionId,browserPage}:{initialSessionId:string;browserPage:string}) =>
  <p>{initialSessionId} {browserPage}</p>}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('reopens the tab session, follows navigation, and ignores a different signed-in actor', async () => {
  let notify!: (event:{tab:string;page:string;actor:string} | null)=>void;
  vi.stubGlobal('spaceDesktop', {onBrowserSidekick:(fn:typeof notify)=>{notify=fn;return ()=>{};},browserSessionId:async()=>'session'});
  let created = false;
  vi.mocked(request).mockImplementation(async (path,body) => {
    if (path === '/agent-sessions/session') {
      if (!created) throw new Error('not_found');
      return {session:{id:'session',owner_id:'me',workspace_id:'work',origin_thread_id:'thread'},context:{channel_id:'private',browser_url:'https://github.com/start'}};
    }
    if (path.endsWith('/sidekick-agents?paired=true')) return [{id:'agent',name:'My agent',capabilities:{skills:['codex.run']}}];
    expect(body).toEqual({client_session_id:'session',installation_id:'agent',skill:'codex.run',source:{browser_url:'https://github.com/start'}});
    created=true;
    return {id:'session',origin_thread_id:'thread',channel_id:'private'};
  });
  render(<BrowserSidekick workspace="work" viewer="me"/>);
  const page={tab:'tab',actor:'me',page:'https://github.com/start'};
  act(()=>notify({...page,actor:'someone-else'}));
  expect(request).not.toHaveBeenCalled();
  act(()=>notify(page));
  await screen.findByText('session https://github.com/start');
  const next={...page,page:'https://github.com/next'};
  act(()=>notify(next));
  await screen.findByText('session https://github.com/next');
  act(()=>notify(null));
  expect(screen.queryByLabelText('Private browser session')).toBeNull();
  act(()=>notify(next));
  await screen.findByText('session https://github.com/next');
  expect(vi.mocked(request).mock.calls.map(([path])=>path)).toEqual([
    '/agent-sessions/session','/workspaces/work/sidekick-agents?paired=true','/workspaces/work/sidekick-sessions','/agent-sessions/session',
  ]);
});
