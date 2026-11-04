import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultPairedConnectors } from '@space/contracts';
import { WorkspaceMembers } from './WorkspaceMembers.js';
const api = vi.hoisted(() => ({ request: vi.fn(), listAll: vi.fn() }));
vi.mock('../../../shared/api/request.js', () => api);
const updates = vi.hoisted(() => new Map<string, () => unknown>());
vi.mock('../../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: (scope: string, id: string, refresh: () => unknown) => { updates.set(`${scope}:${id}`, refresh); void refresh(); return () => updates.delete(`${scope}:${id}`); } }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
const humans = [{ id: 'kai', name: 'Kai', kind: 'human' }];
const props = { workspace: 'workspace', viewer: 'kai', open: true, onClose: vi.fn() };
it('pairs a local Codex without repository or channel setup, and cancels an unused code', async () => {
  api.listAll.mockResolvedValue(humans);
  api.request.mockImplementation(async (path: string) => path === '/agents/connectors' ? defaultPairedConnectors : path.endsWith('agent-pairings') ? { id: 'pair', code: 'a'.repeat(32), expires_at: new Date(Date.now()+600_000).toISOString() } : { status: 'pending' });
  render(<WorkspaceMembers {...props} />);
  await screen.findByText('Kai');
  await userEvent.click(screen.getByRole('button', { name: 'Connect Local Codex' }));
  expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/agent-pairings', {connector_id:'codex.local'});
  expect(await screen.findByLabelText('Pairing code')).toBeTruthy();
  expect(screen.queryByLabelText(/repository/i)).toBeNull();
  expect(screen.queryByLabelText(/channel/i)).toBeNull();
  expect(screen.getByText(/Continue with ChatGPT/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel pairing' }));
  expect(api.request).toHaveBeenCalledWith('/agent-pairings/pair/cancel', {});
  await waitFor(() => expect(screen.queryByLabelText('Pairing code')).toBeNull());
});
it('shows humans and agents together, distinguishes offline/auth-required, and limits disconnect to owner', async () => {
  api.listAll.mockResolvedValue([...humans,
    { id: 'agent', name: 'Kai’s Codex', kind: 'agent', owner_id: 'kai', status: 'auth_required' },
    { id: 'other', name: 'Anna’s Codex', kind: 'agent', owner_id: 'anna', status: 'offline' }]);
  api.request.mockImplementation(async (path:string) => path === '/agents/connectors' ? defaultPairedConnectors : {revoked:true});
  render(<WorkspaceMembers {...props} />);
  await screen.findByText('Kai’s Codex');
  expect(screen.getByText(/Sign-in required/)).toBeTruthy();
  expect(screen.getByText('Offline')).toBeTruthy();
  const disconnect = screen.getByRole('button', { name: 'Disconnect Kai’s Codex' });
  expect(screen.queryByRole('button', { name: 'Disconnect Anna’s Codex' })).toBeNull();
  await userEvent.click(disconnect);
  expect(api.request).toHaveBeenCalledWith('/agents/connections/agent/revoke', {});
});
it('displays creation failures and clears member identities when workspace changes', async () => {
  api.listAll.mockResolvedValue(humans);
  api.request.mockImplementation(async (path:string) => { if(path === '/agents/connectors') return defaultPairedConnectors; throw new Error('rate_limited'); });
  const view = render(<WorkspaceMembers {...props} />);
  await screen.findByText('Kai');
  await userEvent.click(screen.getByRole('button', { name: 'Connect Local Codex' }));
  expect((await screen.findByRole('alert')).textContent).toContain('rate limited');
  api.listAll.mockResolvedValue([]);
  view.rerender(<WorkspaceMembers {...props} workspace="other" />);
  await waitFor(() => expect(screen.queryByText('Kai')).toBeNull());
});
it('receives a claimed pairing over the socket and updates the member status without exposing the consumed code', async () => {
  vi.useFakeTimers();
  api.listAll.mockResolvedValue(humans);
  api.request.mockImplementation(async (path: string) => path === '/agents/connectors' ? defaultPairedConnectors : path.endsWith('agent-pairings') ? { id: 'pair', code: 'b'.repeat(32), expires_at: new Date(Date.now()+600_000).toISOString() } : { status: 'claimed', installation_id: 'agent' });
  await act(async () => { render(<WorkspaceMembers {...props} />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect Local Codex' })); });
  api.listAll.mockResolvedValue([...humans, { id: 'agent', kind: 'agent', name: 'Kai’s Codex', owner_id: 'kai', status: 'online' }]);
  await act(async () => { await updates.get('workspace:workspace')?.(); });
  expect(screen.getByText('Codex paired with this workspace')).toBeTruthy();
  expect(screen.getByText('Your local Codex is connected and signed in.')).toBeTruthy();
  expect(screen.queryByLabelText('Pairing code')).toBeNull();
  api.listAll.mockResolvedValue(humans);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect Kai’s Codex' })); });
  expect(screen.queryByText('Codex paired with this workspace')).toBeNull();
  expect(screen.queryByText('Kai’s Codex')).toBeNull();
});
it('offers a fresh code after expiry and unsubscribes when closed', async () => {
  vi.useFakeTimers();
  api.listAll.mockResolvedValue(humans);
  let n = 0;
  api.request.mockImplementation(async (path: string) => path === '/agents/connectors' ? defaultPairedConnectors : path.endsWith('agent-pairings') ? { id: `pair-${++n}`, code: String(n).repeat(32), expires_at: new Date(Date.now()+600_000).toISOString() } : { status: 'expired' });
  const view = render(<WorkspaceMembers {...props} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect Local Codex' })); });
  await act(async () => { await updates.get('workspace:workspace')?.(); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate new code' })); });
  expect((screen.getByLabelText('Pairing code') as HTMLInputElement).value).toBe('2'.repeat(32));
  view.rerender(<WorkspaceMembers {...props} open={false} />);
  const calls = api.listAll.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(api.listAll.mock.calls.length).toBe(calls);
});
it('ignores old workspace results and cancels pairing created after dialog closure', async () => {
  api.request.mockResolvedValue(defaultPairedConnectors);
  let resolveMembers!: (items: unknown[]) => void;
  api.listAll.mockImplementation((path: string) => path.includes('/workspace/') ? new Promise(resolve => { resolveMembers = resolve; }) : Promise.resolve([{ id: 'anna', kind: 'human', name: 'Anna' }]));
  const view = render(<WorkspaceMembers {...props} />);
  view.rerender(<WorkspaceMembers {...props} workspace="other" />);
  await screen.findByText('Anna');
  await act(async () => { resolveMembers(humans); });
  expect(screen.queryByText('Kai')).toBeNull();
  let resolvePair!: (value: unknown) => void;
  api.request.mockImplementation((path: string) => path === '/agents/connectors' ? defaultPairedConnectors : path.endsWith('agent-pairings') ? new Promise(resolve => { resolvePair = resolve; }) : Promise.resolve({ status: 'cancelled' }));
  await userEvent.click(screen.getByRole('button', { name: 'Connect Local Codex' }));
  view.rerender(<WorkspaceMembers {...props} workspace="other" open={false} />);
  await act(async () => { resolvePair({ id: 'late', code: 'c'.repeat(32), expires_at: new Date(Date.now()+600000).toISOString() }); });
  expect(api.request).toHaveBeenCalledWith('/agent-pairings/late/cancel', {});
  expect(screen.queryByLabelText('Pairing code')).toBeNull();
});

it('expires an unused pairing at its deadline without polling the API', async () => {
  vi.useFakeTimers();
  api.listAll.mockResolvedValue(humans);
  api.request.mockImplementation(async (path:string) => path === '/agents/connectors' ? defaultPairedConnectors : { id: 'expires', code: 'x'.repeat(32), expires_at: new Date(Date.now()+1000).toISOString() });
  await act(async () => { render(<WorkspaceMembers {...props} />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect Local Codex' })); });
  const reads = api.listAll.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect(screen.queryByLabelText('Pairing code')).toBeNull();
  expect(screen.getByRole('button', { name: 'Generate new code' })).toBeTruthy();
  expect(api.listAll).toHaveBeenCalledTimes(reads);
});

it('pairs Kiro with its own connector and local sign-in instructions', async () => {
  api.listAll.mockResolvedValue(humans);
  api.request.mockImplementation(async (path:string) => path === '/agents/connectors' ? defaultPairedConnectors : { id: 'kiro-pair', provider: 'kiro', code: 'k'.repeat(32), expires_at: new Date(Date.now()+600000).toISOString() });
  render(<WorkspaceMembers {...props} />);
  await screen.findByText('Kai');
  await userEvent.selectOptions(screen.getByLabelText('Agent provider'), 'kiro.local');
  await userEvent.click(screen.getByRole('button', { name: 'Connect Local Kiro' }));
  expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/agent-pairings', {connector_id:'kiro.local'});
  expect(screen.getByText(/pnpm connector --provider kiro --url/)).toBeTruthy();
  expect(screen.getByText(/Sign in to Kiro/)).toBeTruthy();
  expect(screen.queryByText(/Continue with ChatGPT/)).toBeNull();
  expect((screen.getByLabelText('Agent provider') as HTMLSelectElement).disabled).toBe(true);
});

it('offers trusted registered connectors beyond built-in providers', async () => {
 api.listAll.mockResolvedValue(humans);
 api.request.mockImplementation(async (path:string) => path === '/agents/connectors' ? [{id:'research.local',definition_id:'research-definition',name:'Research',capabilities:{skills:['research.run'],controls:{},persistent_sessions:true}}] : {id:'research-pair',connector_id:'research.local',code:'r'.repeat(32),expires_at:new Date(Date.now()+600000).toISOString()});
 render(<WorkspaceMembers {...props}/>);
 await screen.findByRole('option',{name:'Research'});
 await userEvent.selectOptions(screen.getByLabelText('Agent provider'),'research.local');
 await userEvent.click(screen.getByRole('button',{name:'Connect Local Research'}));
 expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/agent-pairings',{connector_id:'research.local'});
 expect(await screen.findByLabelText('Pairing code')).toBeTruthy();
 expect(screen.queryByText(/Continue with ChatGPT/)).toBeNull();
});
