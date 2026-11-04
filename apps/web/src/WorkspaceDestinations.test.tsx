import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultPairedConnectors } from '@space/contracts';
import { WorkspaceDestinations } from './WorkspaceDestinations.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./chat-client.js', () => api);
const updates = vi.hoisted(() => new Map<string, { refresh: () => unknown; revoke: (reason: string) => void }>());
vi.mock('./live-updates.js', () => ({ subscribeUpdates: (_scope: string, workspace: string, refresh: () => unknown, revoke: (reason: string) => void) => {
  updates.set(workspace, { refresh, revoke }); void refresh(); return () => updates.delete(workspace);
} }));
const people = [{ id: 'kai', name: 'Kai Tran', kind: 'human' }, { id: 'anna', name: 'Anna Lee', kind: 'human' }, { id: 'agent', name: 'Kai’s Codex', kind: 'agent', status: 'online' }];
const channels = [{ id: 'general', name: 'general', joined: true, topic: 'Team updates', description: '', private: false, archived_at: null }, { id: 'design', name: 'design', joined: false, topic: 'Design work', description: '', private: false, archived_at: null }];
const installations = [{ id: 'agent', workspace_id: 'workspace', owner_id: 'kai', connector_id: 'codex.local', definition_id: 'def', enabled: true, capabilities: { skills: ['codex.run'], controls: {} } }];
const props = { workspace: 'workspace', viewer: 'kai', onOpenChannel: vi.fn(), onOpenMembers: vi.fn(), onOpenAgents: vi.fn() };
function response(path: string): unknown {
  if (path.includes('/participants')) return { items: people, next_cursor: null };
  if (path.includes('/channels?')) return { items: channels, next_cursor: null };
  if (path === '/agents/connectors') return defaultPairedConnectors;
  if (path.startsWith('/agents/installations?')) return installations;
  if (path.endsWith('/join')) return {};
  throw new Error(`Unexpected request: ${path}`);
}
beforeEach(() => { api.request.mockImplementation(async (path: string) => response(path)); });
afterEach(() => { cleanup(); updates.clear(); vi.resetAllMocks(); });

it('shows searchable real people, keeps agents in their own directory, and opens member management', async () => {
  render(<WorkspaceDestinations view="directories" {...props} />);
  await screen.findByText('Kai Tran');
  expect(screen.getByText('You')).toBeTruthy();
  expect(screen.queryByText('Kai’s Codex')).toBeNull();
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search people' }), 'Anna');
  expect(screen.getByText('Anna Lee')).toBeTruthy();
  expect(screen.queryByText('Kai Tran')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Manage members' }));
  expect(props.onOpenMembers).toHaveBeenCalledOnce();
  await userEvent.clear(screen.getByRole('searchbox', { name: 'Search people' }));
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search people' }), 'missing');
  expect(screen.getByText('No people match your search')).toBeTruthy();
});

it('filters channels by topic and joins before opening, retaining failures for retry', async () => {
  render(<WorkspaceDestinations view="directories" {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Channels' }));
  await screen.findByText('general');
  await userEvent.click(screen.getByRole('button', { name: 'Open general' }));
  expect(props.onOpenChannel).toHaveBeenCalledWith('general');
  expect(api.request.mock.calls.some(([path]) => path === '/channels/general/join')).toBe(false);
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search channels' }), 'Design work');
  expect(screen.queryByText('general')).toBeNull();
  api.request.mockImplementation(async (path: string) => { if (path.endsWith('/join')) throw new Error('permission_denied'); return response(path); });
  await userEvent.click(screen.getByRole('button', { name: 'Join design' }));
  expect((await screen.findByRole('alert')).textContent).toContain('permission denied');
  expect(props.onOpenChannel).not.toHaveBeenCalledWith('design');
  api.request.mockImplementation(async (path: string) => response(path));
  await userEvent.click(screen.getByRole('button', { name: 'Join design' }));
  expect(api.request).toHaveBeenCalledWith('/channels/design/join', {});
  await waitFor(() => expect(props.onOpenChannel).toHaveBeenCalledWith('design'));
});

it('exposes honest external and invitation boundaries with working member actions', async () => {
  render(<WorkspaceDestinations view="directories" {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'External' }));
  expect(screen.getByText(/Shared channels with external organizations are not available/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Browse workspace members' }));
  await screen.findByText('Kai Tran');
  await userEvent.click(screen.getByRole('button', { name: 'Invitations' }));
  expect(screen.getByText(/An invitation directory is not available/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Open workspace members' }));
  expect(props.onOpenMembers).toHaveBeenCalledOnce();
});

it('uses installed agents and registered connector catalog, with functioning contextual navigation', async () => {
  render(<WorkspaceDestinations view="agents" {...props} />);
  await screen.findByText('Kai’s Codex');
  expect(screen.getByText('Online · Owned by you')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'View connection' }));
  expect(props.onOpenMembers).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'Available connectors' }));
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search agents' }), 'kiro.run');
  expect(screen.getByRole('heading', { name: 'Kiro' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Codex' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Connect Kiro' }));
  expect(props.onOpenMembers).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole('button', { name: 'Workflows', exact: true }));
  expect(screen.getByText(/workflow builder and third-party workflow automations are not available/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'View installed agents' }));
  expect(screen.getByText('Kai’s Codex')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Apps', exact: true }));
  await userEvent.click(screen.getByRole('button', { name: 'Browse connectors' }));
  expect(screen.getByRole('heading', { name: 'Codex' })).toBeTruthy();
});

it('Spacebot routes to a real channel with an installed agent and does not invoke a backend model', async () => {
  render(<WorkspaceDestinations view="spacebot" {...props} />);
  await screen.findByRole('button', { name: /Kai’s Codex/ });
  expect(screen.getByText(/agent must be enabled in that channel/)).toBeTruthy();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Channel' }), 'design');
  await userEvent.click(screen.getByRole('button', { name: 'Open channel' }));
  await waitFor(() => expect(props.onOpenChannel).toHaveBeenCalledWith('design'));
  expect(api.request).toHaveBeenCalledWith('/channels/design/join', {});
  expect(api.request.mock.calls.some(([path]) => /tasks|sessions/.test(path))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Explore agents & tools' }));
  expect(props.onOpenAgents).toHaveBeenCalledOnce();
});

it.each([
  ['offline', 'Offline', /This agent is offline/],
  ['auth_required', 'Sign-in required', /Sign in to this agent/],
  ['error', 'Connection needs attention', /connection needs attention before/],
  [undefined, 'Status unavailable', /availability could not be confirmed/],
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

it('Huddles states calling is unavailable and opens a real channel instead', async () => {
  render(<WorkspaceDestinations view="huddles" {...props} />);
  await screen.findByText('Audio and video calling are not available in Space.');
  expect(screen.queryByRole('button', { name: /start.*huddle|start.*call/i })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Open channel' }));
  expect(props.onOpenChannel).toHaveBeenCalledWith('general');
});

it('loads another bounded page only on request, and refreshes from workspace updates', async () => {
  api.request.mockImplementation(async (path: string) => path.includes('after=next') ? { items: [{ id: 'chris', kind: 'human', name: 'Chris' }], next_cursor: null } : path.includes('/participants') ? { items: people, next_cursor: 'next' } : response(path));
  render(<WorkspaceDestinations view="directories" {...props} />);
  const more = await screen.findByRole('button', { name: 'Load more people' });
  expect(api.request).toHaveBeenCalledTimes(1);
  await userEvent.click(more);
  await screen.findByText('Chris');
  expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/participants?limit=100&after=next', undefined, undefined, 'POST', expect.any(AbortSignal));
  expect(screen.getByText('Kai Tran')).toBeTruthy();
  api.request.mockResolvedValue({ items: [{ id: 'new', kind: 'human', name: 'New person' }], next_cursor: null });
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
  api.request.mockImplementation((path: string) => path.includes('/workspace/') ? new Promise(done => { resolve = done; }) : Promise.resolve({ items: [{ id: 'other', name: 'Other member', kind: 'human' }], next_cursor: null }));
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
  api.request.mockResolvedValueOnce({ items: [{ id: 'fresh', name: 'Fresh member', kind: 'human' }], next_cursor: null });
  await act(async () => { await updates.get('workspace')?.refresh(); });
  await act(async () => { resolveOld({ items: people, next_cursor: null }); });
  expect(screen.getByText('Fresh member')).toBeTruthy();
  expect(screen.queryByText('Kai Tran')).toBeNull();
  api.request.mockImplementation(async (path: string) => response(path));
  await userEvent.click(screen.getByRole('button', { name: 'Channels' }));
  await screen.findByText('design');
  let resolveJoin!: (result: unknown) => void;
  api.request.mockImplementationOnce(() => new Promise(done => { resolveJoin = done; }));
  await userEvent.click(screen.getByRole('button', { name: 'Join design' }));
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
 const {DestinationTransition}=await import('./DestinationTransition.js');
 const view=render(<DestinationTransition destination="Spacebot"><WorkspaceDestinations view="spacebot" {...props}/></DestinationTransition>);
 await screen.findByRole('combobox',{name:'Channel'});
 await userEvent.selectOptions(screen.getByRole('combobox',{name:'Channel'}),'design');
 await userEvent.click(screen.getByRole('button',{name:/Open channel/}));
 view.rerender(<DestinationTransition destination="Activity">Latest destination</DestinationTransition>);
 await act(async()=>{finish();await pending;});
 expect(props.onOpenChannel).not.toHaveBeenCalled();
 expect(await screen.findByText('Latest destination')).toBeTruthy();
});
