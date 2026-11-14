import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultPairedConnectors } from '@space/contracts';
import { WorkspaceDestinations } from './WorkspaceDestinations.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../shared/api/request.js', () => api);
const updates = vi.hoisted(() => new Map<string, { refresh: () => unknown; revoke: (reason: string) => void }>());
vi.mock('../../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: (_scope: string, workspace: string, refresh: () => unknown, revoke: (reason: string) => void) => {
  updates.set(workspace, { refresh, revoke }); void refresh(); return () => updates.delete(workspace);
} }));
const people = [{ id: 'kai', name: 'Kai Tran', kind: 'human' }, { id: 'anna', name: 'Anna Lee', kind: 'human' }, { id: 'agent', name: 'Kai’s Codex', kind: 'agent', status: 'online' }];
const channels = [{ id: 'general', name: 'general', joined: true, topic: 'Team updates', description: '', private: false, archived_at: null }, { id: 'design', name: 'design', joined: false, topic: 'Design work', description: '', private: false, archived_at: null }];
const installations = [{ id: 'agent', workspace_id: 'workspace', owner_id: 'kai', connector_id: 'codex.local', definition_id: 'def', enabled: true, capabilities: { skills: ['codex.run'], controls: {} } }];
const props = { workspace: 'workspace', viewer: 'kai', onOpenChannel: vi.fn(), onOpenMembers: vi.fn(), onOpenAgents: vi.fn() };
const directoryMembers = people.filter(p=>p.kind==='human').map(p=>({user_id:p.id,display_name:p.name,role:'member',active:true}));
function response(path: string): unknown {
  const params=new URL(path,'https://space.test').searchParams;
  const q=params.get('q')?.toLowerCase()??'';
  if(path.includes('/directory?'))return {items:params.get('guest')==='any_guest'?[]:directoryMembers.filter(p=>p.display_name.toLowerCase().includes(q)),next_cursor:null};
  if(path.includes('/invitations?'))return {items:[],next_cursor:null,role:'owner'};
  if(params.has('directory'))return {items:channels.filter(c=>(c.name+' '+c.topic).toLowerCase().includes(q)),next_cursor:null};
  if (path.includes('/participants')) return { items: people, next_cursor: null };
  if (path.includes('/channels?')) return { items: channels, next_cursor: null };
  if (path === '/agents/connectors') return defaultPairedConnectors;
  if (path.startsWith('/agents/installations?')) return installations;
  if (path.includes('/workflows/published?')) return {items:[],next_cursor:null};
  if (path.includes('/workflows?')) return { items: [{ name: 'IT Help Request', destinations: [{ urgency: 'normal', channel: channels[0] }] }], next_cursor: null };
  if (path.endsWith('/settings')) return { role: 'member' };
  if (path.endsWith('/join')) return {};
  throw new Error(`Unexpected request: ${path}`);
}
beforeEach(() => { api.request.mockImplementation(async (path: string) => response(path)); });
afterEach(() => { cleanup(); updates.clear(); vi.resetAllMocks(); });

it('shows searchable real people, keeps agents in their own directory, and opens member management', async () => {
  render(<WorkspaceDestinations view="directories" {...props} />);
  await screen.findByText('Kai Tran');
  expect(screen.getByText('(you)',{exact:false})).toBeTruthy();
  expect(screen.queryByText('Kai’s Codex')).toBeNull();
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search people' }), 'Anna');
  expect(screen.getByText('Anna Lee')).toBeTruthy();
  await waitFor(()=>expect(screen.queryByText('Kai Tran')).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Manage members' }));
  expect(props.onOpenMembers).toHaveBeenCalledOnce();
  await userEvent.clear(screen.getByRole('searchbox', { name: 'Search people' }));
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search people' }), 'missing');
  await screen.findByText('No people match your search');
});

it('filters channels by topic and joins before opening, retaining failures for retry', async () => {
  render(<WorkspaceDestinations view="directories" {...props} />);
  await userEvent.click(screen.getByRole('tab', { name: 'Channels' }));
  await screen.findByText('general');
  await userEvent.click(screen.getByRole('button', { name: 'Open general' }));
  expect(props.onOpenChannel).toHaveBeenCalledWith('general');
  expect(api.request.mock.calls.some(([path]) => path === '/channels/general/join')).toBe(false);
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search channels' }), 'Design work');
  await waitFor(()=>expect(screen.queryByText('general')).toBeNull());
  api.request.mockImplementation(async (path: string) => { if (path.endsWith('/join')) throw new Error('permission_denied'); return response(path); });
  await userEvent.click(await screen.findByRole('button', { name: 'Join design' }));
  expect((await screen.findByRole('alert')).textContent).toContain('permission denied');
  expect(props.onOpenChannel).not.toHaveBeenCalledWith('design');
  api.request.mockImplementation(async (path: string) => response(path));
  await userEvent.click(await screen.findByRole('button', { name: 'Join design' }));
  expect(api.request).toHaveBeenCalledWith('/channels/design/join', {});
  await waitFor(() => expect(props.onOpenChannel).toHaveBeenCalledWith('design'));
});

it('shows workspace guests and tracks invitations in the directory', async () => {
  render(<WorkspaceDestinations view="directories" {...props} />);
  await userEvent.click(screen.getByRole('tab',{name:'External'}));
  await screen.findByText('No guests in this directory yet');
  await userEvent.click(screen.getByRole('tab',{name:'Invitations'}));
  await screen.findByText('Track your invitations');
  expect(screen.getByRole('button',{name:'Manage invitations'})).toBeTruthy();
});

it('shows workspace agents with functioning contextual navigation', async () => {
  render(<WorkspaceDestinations view="agents" {...props} />);
  await screen.findByText('Kai’s Codex');
  expect(screen.getByRole('status').textContent).toBe('Online');
  expect(screen.getByText('Owned by you')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'View connection' }));
  expect(props.onOpenMembers).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'Workflows', exact: true }));
  await screen.findByRole('region', { name: 'Featured templates' });
  expect(screen.getByRole('tab', {name:'Templates'}).getAttribute('aria-selected')).toBe('true');
  await userEvent.click(screen.getByRole('tab', {name:'Managed by you'}));
  await screen.findByText('Workflows you publish will appear here.');
  expect(api.request.mock.calls.some(([path]) => path.includes('mine=true'))).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Apps', exact: true }));
  await screen.findByText(/Workspace owners and admins manage MCP servers/);
  expect(screen.queryByRole('button', { name: 'Add MCP server' })).toBeNull();
  expect(api.request.mock.calls.some(([path]) => path.endsWith('/connections') || path.endsWith('/connection-agents'))).toBe(false);
});

it('sets up, publishes, and starts an IT request from the workspace gallery', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  let published = false, name = 'IT Help Request';
  api.request.mockImplementation(async (path: string, body?: {name?: string; urgency?: string; description?: string}, _options?: unknown, method?: string) => {
    if (path.endsWith('/workflows/published') && body) {
      expect(body).toMatchObject({ name:'IT Help Request', normal_channel:'general', urgent_channel:'general' });
      published = true;
      return {id:'flow'};
    }
    if (path.endsWith('/published/flow') && method === 'PATCH') {
      expect(body).toMatchObject({revision:1,normal_channel:'general',urgent_channel:'general'});
      name = body!.name!;
      return;
    }
    if (path.includes('/workflows/published?')) return { items:published ? [{id:'flow',name,manager_id:'kai',settings:path.includes('mine=true') ? {revision:1,normal_channel:'general',urgent_channel:'general'} : undefined}] : [], next_cursor:null };
    if (path.endsWith('/flow/requests')) {
      expect(body).toMatchObject({urgency:'normal',description:'VPN issue',request_id:expect.any(String)});
      return {channel_id:'general'};
    }
    return response(path);
  });
  render(<WorkspaceDestinations view="agents" {...props}/>);
  await userEvent.click(screen.getByRole('button', {name:'Workflows'}));
  await userEvent.click(await screen.findByRole('button', {name:'Featured templates'}));
  expect(screen.getAllByRole('button', {name:'Preview IT Help Request'})).toHaveLength(1);
  await userEvent.click(within(screen.getByRole('region',{name:'All templates'})).getByRole('button',{name:'Preview IT Help Request'}));
  await userEvent.click(await screen.findByRole('button', {name:'Set up'}));
  await userEvent.click(screen.getByRole('button', {name:'Publish workflow'}));
  await userEvent.click(await screen.findByRole('button', {name:'Edit IT Help Request'}));
  await userEvent.clear(screen.getByLabelText('Workflow name'));
  await userEvent.type(screen.getByLabelText('Workflow name'),'IT Support');
  await userEvent.click(screen.getByRole('button',{name:'Publish changes'}));
  await screen.findByRole('button',{name:'Edit IT Support'});
  await userEvent.click(screen.getByRole('tab',{name:'All',exact:true}));
  await screen.findByText('IT Support');
  expect(screen.queryByRole('button',{name:'Edit IT Support'})).toBeNull();
  await userEvent.click(await screen.findByRole('button', {name:'Start request'}));
  await userEvent.type(screen.getByLabelText('What do you need help with?'), 'VPN issue');
  await userEvent.click(screen.getByRole('button', {name:'Submit request'}));
  await userEvent.click(await screen.findByRole('button', {name:'Open request channel'}));
  expect(props.onOpenChannel).toHaveBeenCalledWith('general');
});

it('Spacebot routes to a real channel with an installed agent and does not invoke a backend model', async () => {
  render(<WorkspaceDestinations view="spacebot" {...props} />);
  await screen.findByRole('button', { name: /Kai’s Codex/ });
  expect(screen.getByText(/agent must be enabled in that channel/)).toBeTruthy();
  await userEvent.click(screen.getByRole('combobox', { name: 'Channel' })); await userEvent.click(await screen.findByRole('option', { name: '# design · Join channel', exact: true }));
  await userEvent.click(screen.getByRole('button', { name: 'Open channel' }));
  await waitFor(() => expect(props.onOpenChannel).toHaveBeenCalledWith('design'));
  expect(api.request).toHaveBeenCalledWith('/channels/design/join', {});
  expect(api.request.mock.calls.some(([path]) => /tasks|sessions/.test(path))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Explore agents & tools' }));
  expect(props.onOpenAgents).toHaveBeenCalledOnce();
});

it.each([
  ['offline', 'Offline', /This agent is offline/],
  ['auth_required', 'Sign in', /Sign in to this agent/],
  ['error', 'Needs attention', /connection needs attention before/],
  [undefined, 'Unknown', /availability could not be confirmed/],
])('Spacebot gives an honest connection action for status %s', async (status, label, guidance) => {
  api.request.mockImplementation(async (path: string) => path.includes('/participants')
    ? { items: people.map(person => person.kind === 'agent' ? { ...person, status } : person), next_cursor: null } : response(path));
  render(<WorkspaceDestinations view="spacebot" {...props} />);
  const selected = await screen.findByRole('button', { name: new RegExp(`Kai’s Codex.*${label}`) });
  expect(selected.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('status').textContent).toMatch(guidance);
  expect(screen.queryByText(/Continue with/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'View connection' }));
  expect(props.onOpenMembers).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'Open channel' }));
  expect(props.onOpenChannel).toHaveBeenCalledWith('general');
});

it('updates connection guidance when selecting another agent and when presence changes', async () => {
  let status = 'offline';
  api.request.mockImplementation(async (path: string) => path.includes('/participants')
    ? { items: [...people, { id: 'second', name: 'Second agent', kind: 'agent', status }], next_cursor: null }
    : path.startsWith('/agents/installations?') ? [...installations, { ...installations[0], id: 'second' }] : response(path));
  render(<WorkspaceDestinations view="spacebot" {...props} />);
  await userEvent.click(await screen.findByRole('button', { name: /Second agent/ }));
  expect(screen.getByRole('button', { name: /Second agent/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'View connection' })).toBeTruthy();
  status = 'online';
  await act(async () => { await updates.get('workspace')?.refresh(); });
  expect(screen.queryByRole('button', { name: 'View connection' })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('mention this agent');
  expect(screen.getByRole('button', { name: /Second agent/ }).getAttribute('aria-pressed')).toBe('true');
});

it('offers pairing when there are no enabled agents', async () => {
  api.request.mockImplementation(async (path: string) => path.startsWith('/agents/installations?')
    ? [{ ...installations[0], enabled: false }] : response(path));
  render(<WorkspaceDestinations view="spacebot" {...props} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Connect an agent' }));
  expect(props.onOpenMembers).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Open channel' })).toBeNull();
});

it('Huddles explains missing media configuration', async () => {
  render(<WorkspaceDestinations view="huddles" {...props} />);
  await screen.findByText('Huddles need a media connection');
  expect(screen.queryByRole('button', { name: /start.*huddle/i })).toBeNull();
});

it('loads another bounded page only on request, and refreshes from workspace updates', async () => {
  api.request.mockImplementation(async (path: string) => path.includes('after=next') ? { items: [{ user_id: 'chris', display_name: 'Chris' }], next_cursor: null } : path.includes('/directory?') ? { items: directoryMembers, next_cursor: 'next' } : response(path));
  render(<WorkspaceDestinations view="directories" {...props} />);
  const more = await screen.findByRole('button', { name: 'Load more people' });
  expect(api.request).toHaveBeenCalledTimes(1);
  await userEvent.click(more);
  await screen.findByText('Chris');
  expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/directory?limit=100&sort=id&after=next', undefined, undefined, 'POST', expect.any(AbortSignal));
  expect(screen.getByText('Kai Tran')).toBeTruthy();
  api.request.mockResolvedValue({ items: [{ user_id: 'new', display_name: 'New person' }], next_cursor: null });
  await act(async () => { await updates.get('workspace')?.refresh(); });
  expect(screen.getByText('New person')).toBeTruthy();
  expect(screen.queryByText('Kai Tran')).toBeNull();
});

it('shows errors with retry and protects workspace data from late requests and access revocation', async () => {
  api.request.mockRejectedValue(new Error('network_unavailable'));
  const view = render(<WorkspaceDestinations view="directories" {...props} />);
  expect((await screen.findByRole('alert')).textContent).toContain('network unavailable');
  api.request.mockImplementation(async (path: string) => response(path));
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Kai Tran');
  let resolve!: (result: unknown) => void;
  api.request.mockImplementation((path: string) => path.includes('/workspace/') ? new Promise(done => { resolve = done; }) : Promise.resolve({ items: [{ user_id: 'other', display_name: 'Other member' }], next_cursor: null }));
  act(() => { void updates.get('workspace')?.refresh(); });
  view.rerender(<WorkspaceDestinations view="directories" {...props} workspace="other" />);
  await screen.findByText('Other member');
  await act(async () => { resolve({ items: people, next_cursor: null }); });
  expect(screen.queryByText('Kai Tran')).toBeNull();
  act(() => { updates.get('other')?.revoke('forbidden'); });
  expect(screen.queryByText('Other member')).toBeNull();
  expect(within(screen.getByRole('alert')).getByText('forbidden')).toBeTruthy();
});

it('offers a pairing action when no agents are installed', async () => {
  api.request.mockImplementation(async (path: string) => path.startsWith('/agents/installations?') ? [] : response(path));
  render(<WorkspaceDestinations view="spacebot" {...props} />);
  await screen.findByText('Connect your first agent');
  await userEvent.click(screen.getByRole('button', { name: 'Connect an agent' }));
  expect(props.onOpenMembers).toHaveBeenCalledOnce();
});

it('ignores an older read within a workspace and does not navigate after workspace access is revoked', async () => {
  render(<WorkspaceDestinations view="directories" {...props} />);
  await screen.findByText('Kai Tran');
  let resolveOld!: (result: unknown) => void;
  api.request.mockImplementationOnce(() => new Promise(done => { resolveOld = done; }));
  act(() => { void updates.get('workspace')?.refresh(); });
  api.request.mockResolvedValueOnce({ items: [{ user_id: 'fresh', display_name: 'Fresh member' }], next_cursor: null });
  await act(async () => { await updates.get('workspace')?.refresh(); });
  await act(async () => { resolveOld({ items: people, next_cursor: null }); });
  expect(screen.getByText('Fresh member')).toBeTruthy();
  expect(screen.queryByText('Kai Tran')).toBeNull();
  api.request.mockImplementation(async (path: string) => response(path));
  await userEvent.click(screen.getByRole('tab', { name: 'Channels' }));
  await screen.findByText('design');
  let resolveJoin!: (result: unknown) => void;
  api.request.mockImplementationOnce(() => new Promise(done => { resolveJoin = done; }));
  await userEvent.click(await screen.findByRole('button', { name: 'Join design' }));
  act(() => { updates.get('workspace')?.revoke('forbidden'); });
  await act(async () => { resolveJoin({}); });
  expect(props.onOpenChannel).not.toHaveBeenCalled();
  expect(screen.queryByText('design')).toBeNull();
});

it('opens the selected Spacebot connection directly',async()=>{
 api.request.mockImplementation(async(path:string)=>path.includes('/participants')?{items:people.map(person=>person.kind==='agent'?{...person,status:'offline'}:person),next_cursor:null}:response(path));
 const onOpenConnection=vi.fn();render(<WorkspaceDestinations view="spacebot" {...props} onOpenConnection={onOpenConnection}/>);
 await userEvent.click(await screen.findByRole('button',{name:'View connection'}));
 expect(onOpenConnection).toHaveBeenCalledWith('agent');expect(props.onOpenMembers).not.toHaveBeenCalled();
});
it('does not let a pending channel join navigate away from a newer destination during exit',async()=>{
 let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;});
 api.request.mockImplementation(async(path:string)=>path.endsWith('/join')?pending:response(path));
 const {DestinationTransition}=await import('../../../app/navigation/DestinationTransition.js');
 const view=render(<DestinationTransition destination="Spacebot"><WorkspaceDestinations view="spacebot" {...props}/></DestinationTransition>);
 await screen.findByRole('combobox',{name:'Channel'});
 await userEvent.click(screen.getByRole('combobox',{name:'Channel'})); await userEvent.click(await screen.findByRole('option', { name: '# design · Join channel', exact: true }));
 await userEvent.click(screen.getByRole('button',{name:/Open channel/}));
 view.rerender(<DestinationTransition destination="Activity">Latest destination</DestinationTransition>);
 await act(async()=>{finish();await pending;});
 expect(props.onOpenChannel).not.toHaveBeenCalled();
 expect(await screen.findByText('Latest destination')).toBeTruthy();
});


it('shows the live Spacebot welcome without a redundant header',async()=>{
 const view=render(<WorkspaceDestinations view="spacebot" {...props}/>);
 await screen.findByRole('heading',{name:'What would you like to work on?'});
 expect(view.container.querySelector('.wd-bot-mark svg[data-spacebot]')).toBeTruthy();
 expect(view.container.querySelector('.wd-header')).toBeNull();
});


it('opens agent setup and existing connections directly', async () => {
 const onConnectAgent = vi.fn(), onOpenConnection = vi.fn();
 render(<WorkspaceDestinations view="agents" {...props} onConnectAgent={onConnectAgent} onOpenConnection={onOpenConnection}/>);
 await screen.findByText('Kai’s Codex');
 await userEvent.click(screen.getByRole('button',{name:'Connect an agent'}));
 expect(onConnectAgent).toHaveBeenCalledWith(undefined);
 await userEvent.click(screen.getByRole('button',{name:'View connection'}));
 expect(onOpenConnection).toHaveBeenCalledWith('agent');
 expect(props.onOpenMembers).not.toHaveBeenCalled();
});


it('shows a single searchable agent list without a connector catalog', async () => {
  render(<WorkspaceDestinations view="agents" {...props} />);
  await screen.findByText('Kai’s Codex');
  expect(screen.queryByRole('tablist', { name: 'Agent catalog' })).toBeNull();
  expect(screen.queryByText('Available connectors')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Kiro' })).toBeNull();
  const search = screen.getByRole('searchbox', { name: 'Search agents' });
  await userEvent.type(search, 'codex.run');
  expect(screen.getByText('Kai’s Codex')).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.type(search, 'No matching agent');
  expect(screen.getByText('No agents match your search')).toBeTruthy();
  await userEvent.clear(search);
  expect(screen.getByText('Kai’s Codex')).toBeTruthy();
});

it('updates the agent status badge from presence and keeps disabled agents distinct', async () => {
  let status: string | undefined = 'offline', enabled = true;
  api.request.mockImplementation(async (path: string) => path.includes('/participants')
    ? { items: people.map(person => person.kind === 'agent' ? { ...person, status } : person), next_cursor: null }
    : path.startsWith('/agents/installations?') ? [{ ...installations[0], enabled }] : response(path));
  render(<WorkspaceDestinations view="agents" {...props} />);
  await screen.findByText('Kai’s Codex');
  expect(screen.getByRole('status').textContent).toBe('Offline');
  status = 'online';
  await act(async () => { await updates.get('workspace')?.refresh(); });
  expect(screen.getByRole('status').textContent).toBe('Online');
  enabled = false;
  await act(async () => { await updates.get('workspace')?.refresh(); });
  expect(screen.getByRole('status').textContent).toBe('Disabled');
  expect(screen.getByRole('status').querySelector('.sp-status-dot')).toBeNull();
  enabled = true; status = undefined;
  await act(async () => { await updates.get('workspace')?.refresh(); });
  expect(screen.getByRole('status').textContent).toBe('Unknown');
  expect(screen.getByRole('status').getAttribute('data-state')).toBe('unknown');
  expect(screen.getByRole('status').querySelector('.sp-status-dot')).toBeTruthy();
});

it('manages workspace MCP servers and drops credentials when the viewer loses the admin role', async () => {
  let role = 'admin';
  const item = { id: 'service', name: 'Team tools', url: 'https://team.example.com/mcp', auth_type: 'bearer', enabled: true, revision: 3, status: 'ready', tools: [{ name: 'lookup' }, { name: 'report' }], grants: [] };
  api.request.mockImplementation(async (path: string) => {
    if (path === '/workspaces/workspace/settings') return { role };
    if (path === '/workspaces/workspace/connections') return {
      items: [item],
      agents: { items: [{ id: 'first', name: 'First agent', workspace_name: 'Team' }], next_cursor: 'first' },
    };
    if (path === '/workspaces/workspace/connections?after=first') return {
      items: [{ ...item, grants: [{ installation_id: 'installed', tools: ['lookup'] }] }],
      agents: { items: [{ id: 'installed', name: 'Team agent', workspace_name: 'Team' }], next_cursor: null },
    };
    if (path.startsWith('/workspaces/workspace/connections/service')) return {};
    return response(path);
  });
  const view = render(<WorkspaceDestinations view="agents" {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Apps' }));
  const row = within(await screen.findByRole('region', { name: 'Team tools' }));
  expect(screen.queryByRole('region', { name: 'Recent tool calls' })).toBeNull();
  expect(api.request.mock.calls.some(([path]) => path.includes('connection-calls') || path.includes('connection-agents') || path.startsWith('/me/'))).toBe(false);
  await userEvent.click(row.getByRole('button', { name: 'Agent access' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next agents' }));
  await screen.findByRole('button', { name: 'Previous agents' });
  expect((screen.getByRole('checkbox', { name: 'lookup' }) as HTMLInputElement).checked).toBe(true);
  await userEvent.click(screen.getByRole('checkbox', { name: 'report' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save access' }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/connections/service/grants', { revision: 3, installation_id: 'installed', tools: ['lookup', 'report'] }, undefined, 'PUT', undefined, undefined));
  await userEvent.click(row.getByRole('button', { name: 'Edit' }));
  const url = screen.getByLabelText('MCP endpoint');
  await userEvent.clear(url);
  await userEvent.type(url, 'https://other.example.com/mcp');
  expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Bearer token'), 'replacement');
  expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(false);
  role = 'member';
  await act(async () => { await updates.get('workspace')?.refresh(); });
  expect(screen.queryByLabelText('Bearer token')).toBeNull();
  expect(screen.queryByText('Team tools')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add MCP server' })).toBeNull();
  role = 'owner';
  await act(async () => { await updates.get('workspace')?.refresh(); });
  await screen.findByText('Team tools');
  await userEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
  await userEvent.type(screen.getByLabelText('Bearer token'), 'draft');
  view.rerender(<WorkspaceDestinations view="agents" {...props} viewer="other-admin" />);
  expect(screen.queryByLabelText('Bearer token')).toBeNull();
  await userEvent.click(await screen.findByRole('button', { name: 'Add MCP server' }));
  await userEvent.type(screen.getByLabelText('Bearer token'), 'another-draft');
  view.rerender(<WorkspaceDestinations view="agents" {...props} workspace="other" />);
  expect(screen.queryByLabelText('Bearer token')).toBeNull();
  expect(screen.queryByText('Team tools')).toBeNull();
});

it('clears the workspace editor when the server denies a request after the role read', async () => {
  let forbidden = false;
  api.request.mockImplementation(async (path: string) => {
    if (path.endsWith('/settings')) return { role: 'owner' };
    if (path.endsWith('/connections')) {
      if (forbidden) throw new Error('workspace_management_forbidden');
      return { items: [], agents: { items: [] } };
    }
    return response(path);
  });
  render(<WorkspaceDestinations view="agents" {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Apps' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Add MCP server' }));
  await userEvent.type(screen.getByLabelText('Bearer token'), 'draft');
  forbidden = true;
  await act(async () => { await updates.get('workspace')?.refresh(); });
  expect(screen.queryByLabelText('Bearer token')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add MCP server' })).toBeNull();
});

it('only removes saved grants when an agent becomes unavailable during editing', async () => {
  let canGrant = true;
  const item = { id: 'service', name: 'Team tools', url: 'https://team.example.com/mcp', auth_type: 'none', enabled: true, revision: 4, status: 'ready', tools: [{ name: 'read' }, { name: 'write' }], grants: [{ installation_id: 'paired', tools: ['read'] }] };
  api.request.mockImplementation(async (path: string) => {
    if (path.endsWith('/settings')) return { role: 'admin' };
    if (path.endsWith('/connections')) return { items: [item], agents: { items: [{ id: 'paired', name: 'Team agent', workspace_name: 'Team', can_grant: canGrant }] } };
    if (path.endsWith('/grants')) return {};
    return response(path);
  });
  render(<WorkspaceDestinations view="agents" {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Apps' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Agent access' }));
  const read = screen.getByRole('checkbox', { name: 'read' }) as HTMLInputElement;
  const write = screen.getByRole('checkbox', { name: 'write' }) as HTMLInputElement;
  await userEvent.click(write);
  expect(write.checked).toBe(true);
  canGrant = false;
  await act(async () => { await updates.get('workspace')?.refresh(); });
  expect(screen.getByRole('combobox', { name: 'Agent' }).textContent).toContain('Unavailable');
  expect(write.checked).toBe(false);
  expect(write.disabled).toBe(true);
  expect(read.checked).toBe(true);
  const save = screen.getByRole('button', { name: 'Save access' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  await userEvent.click(read);
  expect(save.disabled).toBe(false);
  await userEvent.click(read);
  expect(read.checked).toBe(true);
  expect(save.disabled).toBe(true);
  await userEvent.click(read);
  await userEvent.click(save);
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/connections/service/grants', { revision: 4, installation_id: 'paired', tools: [] }, undefined, 'PUT', undefined, undefined));
});

it.each(['people', 'channels', 'knowledge'])('installs a workspace knowledge source of kind %s', async kind => {
  api.request.mockImplementation(async (path: string) => {
    if (path.endsWith('/settings')) return { role: 'owner' };
    if (path.endsWith('/connections')) return { items: [], agents: { items: [] } };
    return response(path);
  });
  render(<WorkspaceDestinations view="agents" {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Apps' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Add MCP server' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Connection type' }));
  await userEvent.click(screen.getByRole('option', { name: kind === 'people' ? 'Space people directory' : kind === 'channels' ? 'Space channel directory' : 'External knowledge plugin' }));
  if (kind !== 'knowledge') {
    expect(screen.queryByLabelText('MCP endpoint')).toBeNull();
    expect(screen.queryByLabelText('Bearer token')).toBeNull();
  } else {
    await userEvent.type(screen.getByLabelText('Connection name'), 'Catalog');
    await userEvent.type(screen.getByLabelText('MCP endpoint'), 'https://kb.example/mcp');
    await userEvent.click(screen.getByRole('combobox', { name: 'Authentication' }));
    await userEvent.click(screen.getByRole('option', { name: 'No authentication' }));
  }
  await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/connections', {
    kind, name: kind === 'people' ? 'People directory' : kind === 'channels' ? 'Channel directory' : 'Catalog',
    url: kind !== 'knowledge' ? 'space:' + kind : 'https://kb.example/mcp', auth_type: 'none',
  }, undefined, 'POST', undefined, undefined);
});

it('lets users choose a Spacebot agent while channel choices are pending', async () => {
  let finish!: (value: unknown) => void;
  api.request.mockImplementation(async (path: string) => path.includes('/channels?')
    ? new Promise(resolve => { finish = resolve; })
    : response(path));
  render(<WorkspaceDestinations view="spacebot" {...props}/>);
  await userEvent.click(await screen.findByRole('button', { name: /Kai’s Codex/ }));
  expect(screen.getByText('Loading channels…')).toBeTruthy();
  expect(screen.queryByText(/No active channels/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /Explore agents/ }));
  expect(props.onOpenAgents).toHaveBeenCalledOnce();
  await act(async () => finish({ items: channels, next_cursor: null }));
  expect(screen.getByRole('combobox', { name: 'Channel' })).toBeTruthy();
  expect(screen.queryByText('Loading channels…')).toBeNull();
});
