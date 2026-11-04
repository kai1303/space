import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentRequest } from './AgentRequest.js';
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./chat-client.js', () => api);
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const agent = { id: 'local', workspace_id: 'workspace', owner_id: 'owner', definition_id: 'definition', connector_id: 'codex.local', enabled: true, capabilities: { skills: ['codex.run'], controls: {} } };
const candidate = { installation_id: 'local', name: 'Kai’s Codex', skill: 'codex.run', description: 'Local agent' };
it('discovers a newly paired Codex, enables it explicitly for this channel, then requests an approved task', async () => {
  let enabled = false;
  api.request.mockImplementation(async (path: string) => {
    if (path.startsWith('/agents/installations')) return [agent];
    if (path.endsWith('/agents')) return [{ id: 'local', name: 'Kai’s Codex', skills:['codex.run'],granted_skills:enabled?['codex.run']:[],enabled_in_channel: enabled }];
    if (path.endsWith('/navigator')) return { candidates: enabled ? [candidate] : [] };
    if (path.endsWith('/channels/channel')) { enabled = true; return { enabled_in_channel: true }; }
    return { id: 'task' };
  });
  const props = { workspace: 'workspace', channel: 'channel', thread: 'thread', agents: [], onCandidates: vi.fn() };
  render(<AgentRequest {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Enable Kai’s Codex in this channel' }));
  expect(api.request).toHaveBeenCalledWith('/agents/connections/local/channels/channel', { enabled: true, skill:'codex.run' });
  const select = await screen.findByRole('combobox', { name: 'Agent and skill' });
  await userEvent.selectOptions(select, 'local|codex.run');
  await userEvent.type(screen.getByRole('textbox', { name: 'What should the agent do?' }), 'Say hello');
  await userEvent.click(screen.getByRole('button', { name: 'Request task' }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/tasks', { workspace_id: 'workspace', thread_id: 'thread', installation_id: 'local', skill: 'codex.run', goal: 'Say hello' }, expect.any(String)));
  expect(props.onCandidates).toHaveBeenCalledWith([candidate]);
});
it('does not offer an ungranted local skill and makes discovery errors visible', async () => {
  api.request.mockRejectedValue(new Error('not_found'));
  const props = { workspace: 'workspace', channel: 'private', thread: 'thread', agents: [agent], onCandidates: vi.fn() };
  render(<AgentRequest {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Ask an agent' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'not found');
  expect(screen.queryByRole('option', { name: /codex.run/ })).toBeNull();
});
it('grants and revokes each supported skill independently for a custom connector', async () => {
 const custom={...agent,connector_id:'research.local',capabilities:{skills:['research.run','research.review'],controls:{}}};
 let grants=['research.review'];
 api.request.mockImplementation(async(path:string,body?:any)=>{
  if(path.startsWith('/agents/installations'))return [custom];
  if(path.endsWith('/agents'))return [{id:'local',name:'Research',skills:custom.capabilities.skills,granted_skills:grants,enabled_in_channel:grants.length>0}];
  if(path.endsWith('/navigator'))return {candidates:grants.map(skill=>({...candidate,name:'Research',skill}))};
  if(path.endsWith('/channels/channel')){grants=body.enabled?[...grants,body.skill]:grants.filter(skill=>skill!==body.skill);return {};}
  return {};
 });
 render(<AgentRequest workspace="workspace" channel="channel" thread="thread" agents={[]} onCandidates={()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'Ask an agent'}));
 await userEvent.click(await screen.findByRole('button',{name:'Enable Research · research.run in this channel'}));
 expect(api.request).toHaveBeenCalledWith('/agents/connections/local/channels/channel',{enabled:true,skill:'research.run'});
 await userEvent.click(await screen.findByRole('button',{name:'Disable Research · research.review in this channel'}));
 expect(api.request).toHaveBeenCalledWith('/agents/connections/local/channels/channel',{enabled:false,skill:'research.review'});
 expect(grants).toEqual(['research.run']);
});
