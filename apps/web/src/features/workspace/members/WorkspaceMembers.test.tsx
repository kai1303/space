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
  await screen.findByRole('button', { name: 'Connect Local Codex' });
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
it('shows agent connections separately from people and limits disconnect to the owner', async () => {
  api.listAll.mockResolvedValue([...humans,
    { id: 'agent', name: 'Kai’s Codex', kind: 'agent', owner_id: 'kai', status: 'auth_required' },
    { id: 'other', name: 'Anna’s Codex', kind: 'agent', owner_id: 'anna', status: 'offline' }]);
  api.request.mockImplementation(async (path:string) => path === '/agents/connectors' ? defaultPairedConnectors : {revoked:true});
  render(<WorkspaceMembers {...props} />);
  await screen.findByText('Kai’s Codex');
  expect(screen.getByText(/Sign-in required/)).toBeTruthy();
  expect(screen.getByText('Offline')).toBeTruthy();
  expect(screen.queryByText('Kai')).toBeNull();
  const disconnect = screen.getByRole('button', { name: 'Disconnect Kai’s Codex' });
  expect(screen.queryByRole('button', { name: 'Disconnect Anna’s Codex' })).toBeNull();
  await userEvent.click(disconnect);
  expect(api.request).toHaveBeenCalledWith('/agents/connections/agent/revoke', {});
});
it('displays creation failures and clears member identities when workspace changes', async () => {
  api.listAll.mockResolvedValue(humans);
  api.request.mockImplementation(async (path:string) => { if(path === '/agents/connectors') return defaultPairedConnectors; throw new Error('rate_limited'); });
  const view = render(<WorkspaceMembers {...props} />);
  await screen.findByRole('button', { name: 'Connect Local Codex' });
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
  api.listAll.mockImplementation((path: string) => path.includes('/workspace/') ? new Promise(resolve => { resolveMembers = resolve; }) : Promise.resolve([{ id: 'anna', kind: 'agent', name: 'Anna' }]));
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
  await screen.findByRole('button', { name: 'Connect Local Codex' });
  await userEvent.click(screen.getByRole('combobox', { name: 'Agent provider' }));
  await userEvent.click(screen.getByRole('option', { name: 'Kiro' }));
  await userEvent.click(screen.getByRole('button', { name: 'Connect Local Kiro' }));
  expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/agent-pairings', {connector_id:'kiro.local'});
  expect(screen.getByText(/pnpm connector --provider kiro --url/)).toBeTruthy();
  expect(screen.getByText(/Sign in to Kiro/)).toBeTruthy();
  expect(screen.queryByText(/Continue with ChatGPT/)).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Agent provider' })).toBeNull();
});

it('pairs Claude with its own connector and local sign-in instructions', async () => {
  api.listAll.mockResolvedValue(humans);
  api.request.mockImplementation(async (path:string) => path === '/agents/connectors' ? defaultPairedConnectors : { id: 'claude-pair', provider: 'claude', code: 'k'.repeat(32), expires_at: new Date(Date.now()+600000).toISOString() });
  render(<WorkspaceMembers {...props} />);
  await screen.findByRole('button', { name: 'Connect Local Codex' });
  await userEvent.click(screen.getByRole('combobox', { name: 'Agent provider' }));
  await userEvent.click(screen.getByRole('option', { name: 'Claude' }));
  await userEvent.click(screen.getByRole('button', { name: 'Connect Local Claude' }));
  expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/agent-pairings', {connector_id:'claude.local'});
  expect(screen.getByText(/pnpm connector --provider claude --url/)).toBeTruthy();
  expect(screen.getByText(/Sign in to Claude/)).toBeTruthy();
  expect(screen.queryByText(/Continue with ChatGPT/)).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Agent provider' })).toBeNull();
});

it('offers trusted registered connectors beyond built-in providers', async () => {
 api.listAll.mockResolvedValue(humans);
 api.request.mockImplementation(async (path:string) => path === '/agents/connectors' ? [{id:'research.local',definition_id:'research-definition',name:'Research',capabilities:{skills:['research.run'],controls:{},persistent_sessions:true}}] : {id:'research-pair',connector_id:'research.local',code:'r'.repeat(32),expires_at:new Date(Date.now()+600000).toISOString()});
 render(<WorkspaceMembers {...props}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Connect Research'}));
 expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/agent-pairings',{connector_id:'research.local'});
 expect(await screen.findByLabelText('Pairing code')).toBeTruthy();
 expect(screen.queryByText(/Continue with ChatGPT/)).toBeNull();
});


it('uses design-system dropdowns and shows a clear cloud setup boundary without creating a pairing', async () => {
  api.listAll.mockResolvedValue(humans);
  api.request.mockResolvedValue(defaultPairedConnectors);
  render(<WorkspaceMembers {...props} />);
  await screen.findByRole('combobox', { name: 'Agent provider' });
  expect(screen.getByRole('dialog', { name: 'Connect an agent' })).toBeTruthy();
  expect(screen.queryByText('Kai')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Agent provider' }).tagName).toBe('BUTTON');
  await userEvent.click(screen.getByRole('combobox', { name: 'Connection type' }));
  await userEvent.click(screen.getByRole('option', { name: 'Cloud runner' }));
  expect(screen.getByText('No cloud connectors configured')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Connect Local/ })).toBeNull();
  expect(api.request.mock.calls.some(([path]) => path.endsWith('agent-pairings'))).toBe(false);
  await userEvent.click(screen.getByRole('combobox', { name: 'Connection type' }));
  await userEvent.click(screen.getByRole('option', { name: 'Hosted endpoint' }));
  expect(screen.getByText('Connect a hosted HTTP agent')).toBeTruthy();
  expect(screen.queryByLabelText('Pairing code')).toBeNull();
});

it('preselects a registered cloud connector and gives remote instructions through pairing completion', async () => {
  const cloud = {id:'research.cloud',definition_id:'research-definition',name:'Research',capabilities:{skills:['research.run'],controls:{},persistent_sessions:true}};
  api.listAll.mockResolvedValue(humans);
  api.request.mockImplementation(async (path:string) => path === '/agents/connectors' ? [...defaultPairedConnectors, cloud] : path.endsWith('agent-pairings') ? {id:'cloud-pair',connector_id:cloud.id,code:'r'.repeat(32),expires_at:new Date(Date.now()+600000).toISOString()} : {status:'claimed',installation_id:'cloud-agent'});
  render(<WorkspaceMembers {...props} initialConnector="research.cloud" />);
  await userEvent.click(await screen.findByRole('button', {name:'Connect Research'}));
  expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/agent-pairings', {connector_id:'research.cloud'});
  expect(screen.getByText('Connect Research to your cloud runner')).toBeTruthy();
  expect(screen.getByLabelText('Space URL')).toBeTruthy();
  expect(screen.queryByText(/on your computer|local login|Continue with ChatGPT/)).toBeNull();
  await act(async () => { await updates.get('workspace:workspace')?.(); });
  expect(screen.getByText('Research paired with this workspace')).toBeTruthy();
  expect(screen.getByText(/Start your cloud runner/)).toBeTruthy();
  expect(screen.queryByLabelText('Pairing code')).toBeNull();
});

it('hands a local pairing directly to Desktop and shows the confirmed workspace status', async () => {
  const pair = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('spaceDesktop', { pair });
  try {
    api.listAll.mockResolvedValue(humans);
    api.request.mockImplementation(async (path: string) => path === '/agents/connectors' ? defaultPairedConnectors
      : path.endsWith('agent-pairings') ? { id: 'mac', code: 'd'.repeat(32), expires_at: new Date(Date.now()+600000).toISOString() }
      : { status: 'claimed', installation_id: 'installed' });
    render(<WorkspaceMembers {...props} initialConnector="claude.local"/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect on this Mac' }));
    expect(pair).toHaveBeenCalledWith('claude', 'd'.repeat(32));
    expect(await screen.findByText('Claude paired with this workspace')).toBeTruthy();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

it('cancels an unclaimed desktop pairing and lets the user retry a missing CLI', async () => {
  vi.stubGlobal('spaceDesktop', { pair: vi.fn().mockRejectedValue(new Error('Install codex on this Mac.')) });
  try {
    api.listAll.mockResolvedValue(humans);
    api.request.mockImplementation(async (path: string) => path === '/agents/connectors' ? defaultPairedConnectors
      : path.endsWith('agent-pairings') ? { id: 'mac', code: 'd'.repeat(32), expires_at: new Date(Date.now()+600000).toISOString() }
      : { status: 'cancelled' });
    render(<WorkspaceMembers {...props}/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect on this Mac' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Install codex');
    expect(api.request).toHaveBeenCalledWith('/agent-pairings/mac/cancel', {});
    expect(screen.getByRole('button', { name: 'Connect on this Mac' })).toBeTruthy();
  } finally { vi.unstubAllGlobals(); }
});

it('opens the selected workspace in Desktop from a Mac browser without issuing a pairing code', async () => {
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const touches = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ['arm64'] }));
  try {
    api.listAll.mockResolvedValue(humans);
    api.request.mockResolvedValue(defaultPairedConnectors);
    render(<WorkspaceMembers {...props} initialConnector="kiro.local"/>);
    const link = new URL((await screen.findByRole('link', { name: 'Open Space Desktop' })).getAttribute('href')!);
    expect(link.host).toBe('connect');
    expect(Object.fromEntries(link.searchParams)).toEqual({origin:window.location.origin, workspace:'workspace', provider:'kiro'});
    expect((await screen.findByRole('link', {name:'Download for Apple silicon'})).getAttribute('href')).toBe('/downloads/Space-arm64.dmg');
    expect(screen.getByRole('button', {name:'Use the CLI'})).toBeTruthy();
    expect(api.request).not.toHaveBeenCalledWith('/workspaces/workspace/agent-pairings', expect.anything());
  } finally {
    platform.mockRestore();
    if (touches) Object.defineProperty(navigator, 'maxTouchPoints', touches);
    else Reflect.deleteProperty(navigator, 'maxTouchPoints');
    vi.unstubAllGlobals();
  }
});
