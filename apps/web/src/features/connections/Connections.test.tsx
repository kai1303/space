import { useRef } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from '@space/ui/primitives';
import userEvent from '@testing-library/user-event';
import { BrowserSidekick } from '../agents/BrowserSidekick.js';
import { Connections } from './Connections.js';
import { UserSettings } from '../profile/UserProfile.js';

// Dialog motion has its own tests. Resolving its exit deterministically lets this suite
// advance the subscription clock without stranding an animation on a discarded timer.
vi.mock('motion/react', async importOriginal => {
  const actual = await importOriginal<typeof import('motion/react')>();
  const animate = () => Object.assign(Promise.resolve(), { stop() {} });
  return { ...actual, useAnimate: () => [useRef(null), animate] };
});
vi.mock('../auth/AuthScreen.js', () => ({ SignOutButton: () => <button>Sign out</button> }));
const updates = vi.hoisted(() => new Map<string, () => unknown>());
const revocations = vi.hoisted(() => new Map<string, () => void>());
vi.mock('../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: (scope: string, id: string, refresh: () => unknown, revoke: () => void) => { updates.set(`${scope}:${id}`, refresh); revocations.set(`${scope}:${id}`, revoke); void refresh(); return () => { updates.delete(`${scope}:${id}`); revocations.delete(`${scope}:${id}`); }; } }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); updates.clear(); revocations.clear(); });
const base = { id: 'personal', name: 'GitHub personal', url: 'https://mcp.example.com/mcp', auth_type: 'bearer', enabled: true, revision: 1, status: 'ready', tools: [{ name: 'search', description: 'Search issues', inputSchema: { type: 'object' } }, { name: 'write', inputSchema: { type: 'object' } }], grants: [{ installation_id: 'agent', tools: ['search'] }], created_at: '2026-11-06T00:00:00Z' };
function setup(fail = '') {
  let items = [structuredClone(base), { ...structuredClone(base), id: 'work', name: 'GitHub work', grants: [] }];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(options.body as string) : {};
    const ok = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
    if (url === '/v1/me') return ok({ id: 'user', display_name: 'Kai', full_name: '', time_zone: 'UTC', status: null, presence: 'active' });
    if (method !== 'GET' && fail) return { ok: false, status: 409, json: async () => ({ error: fail }) };
    if (url === '/v1/me/connection-agents') return ok({ items: [{ id: 'agent', name: 'My Codex', workspace_name: 'Space' }] });
    if (url === '/v1/me/connection-calls') return ok({ items: [{ id: 'call', connection_name: 'GitHub personal', tool_name: 'search', agent_name: 'My Codex', status: 'uncertain', duration_ms: null, created_at: base.created_at }] });
    if (url === '/v1/me/connections' && method === 'GET') return ok({ items });
    if (url === '/v1/me/connections' && method === 'POST') {
      const { token: _token, ...safe } = body;
      const created = { ...structuredClone(base), ...safe, id: 'new', tools: [], grants: [], status: 'untested' };
      items = [...items, created]; return ok(created);
    }
    const id = url.split('/')[4];
    const current = items.find(item => item.id === id)!;
    if (method === 'DELETE') { items = items.filter(item => item.id !== id); return ok({ deleted: true }); }
    const next = { ...current, revision: current.revision + 1 };
    if (url.endsWith('/grants')) next.grants = [{ installation_id: body.installation_id, tools: body.tools }];
    else if (url.endsWith('/discover')) next.status = 'ready';
    else { const { token: _token, ...safe } = body; Object.assign(next, safe, { revision: current.revision + 1 }); }
    items = items.map(item => item.id === id ? next : item); return ok(next);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<UserSettings user="Kai" userId="user" />);
  return fetcher;
}
async function open() {
  await userEvent.click(screen.getByRole('button', { name: 'Your account' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Connections' }));
  await screen.findByRole('heading', { name: 'GitHub personal' });
}
function connection(name = 'GitHub personal') { return within(screen.getByRole('region', { name })); }

it('opens personal accounts with truthful transport, observed status and call metadata', async () => {
  setup(); await open();
  expect(screen.getByRole('heading', { name: 'GitHub work' })).toBeTruthy();
  expect(screen.getByText(/Streamable HTTP/)).toBeTruthy();
  expect(screen.getByText(/OAuth.*not supported/)).toBeTruthy();
  expect(connection().getByText(/Last observed: Ready/)).toBeTruthy();
  expect(screen.getByText('Uncertain')).toBeTruthy();
  expect(screen.getByText(/may have completed/)).toBeTruthy();
});
it('prefills a suggested personal MCP and waits for the user to provide credentials and save', async () => {
  const fetcher = setup();
  const site = { name: 'Linear', url: 'https://mcp.linear.app/mcp' };
  let notify!: (preset: typeof site & { actor: string; showGuide?: boolean }) => void;
  vi.stubGlobal('spaceDesktop', { onBrowserMcpSetup: (handler: typeof notify) => { notify = handler; return () => {}; } });
  render(<BrowserSidekick workspace="workspace" viewer="user" />);
  act(() => notify({ ...site, actor: 'another-user' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => notify({ ...site, actor: 'user', showGuide: true }));
  expect((await screen.findByLabelText('Connection name') as HTMLInputElement).value).toBe(site.name);
  expect((screen.getByLabelText('MCP endpoint') as HTMLInputElement).value).toBe(site.url);
  const token = screen.getByLabelText('Bearer token') as HTMLInputElement;
  expect(token.value).toBe('');
  expect(screen.getByText('How to get a Linear token').closest('details')?.open).toBe(true);
  expect(screen.getByRole('link', { name: 'Linear token documentation' }).getAttribute('href')).toBe('https://linear.app/docs/api-and-webhooks');
  const endpoint = screen.getByLabelText('MCP endpoint');
  fireEvent.change(endpoint, { target: { value: 'https://mcp.linear.app.example.org/mcp' } });
  expect(screen.getByText('How to get a bearer token')).toBeTruthy();
  expect(screen.queryByText('Linear token documentation')).toBeNull();
  fireEvent.change(endpoint, { target: { value: site.url } });
  expect(fetcher.mock.calls.every(([, opts]) => opts?.method === 'GET')).toBe(true);
  fireEvent.change(token, { target: { value: 'test-token' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByRole('heading', { name: site.name });
  const writes = fetcher.mock.calls.filter(([, opts]) => opts?.method !== 'GET');
  expect(writes.map(([url]) => url)).toEqual(['/v1/me/connections']);
  expect(JSON.parse(writes[0][1]!.body as string)).toMatchObject(site);
});
it('navigates from personal Connections to the Vault subpage', async () => {
  setup();
  const open = vi.fn(), close = vi.fn();
  render(<Connections userId="user" onClose={close} onOpenVault={open}/>);
  await userEvent.click(await screen.findByRole('link', {name:'Open personal Vault'}));
  expect(close).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledOnce();
});
it('hands a Mac browser credential to native Vault without a web password field or server write', async () => {
  const fetcher = setup();
  const close = vi.fn();
  const saveBrowserVaultToken = vi.fn(async () => 'saved');
  vi.stubGlobal('spaceDesktop', { saveBrowserVaultToken });
  const site = { name: 'Linear', url: 'https://mcp.linear.app/mcp', showGuide: true };
  render(<Connections userId="user" suggested={site} onClose={close}/>);
  expect(screen.queryByLabelText('Bearer token')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Save token on this Mac' }));
  expect(saveBrowserVaultToken).toHaveBeenCalledWith(site.url);
  expect(close).toHaveBeenCalled();
  expect(fetcher.mock.calls.every(([, opts]) => opts?.method === 'GET')).toBe(true);
});
it('shows the existing personal connection if the endpoint was added before setup opened', async () => {
  setup();
  render(<Connections userId="user" suggested={{ name: 'GitHub', url: base.url + '/' }} onClose={() => {}}/>);
  await screen.findByRole('heading', { name: base.name });
  expect(screen.queryByLabelText('MCP endpoint')).toBeNull();
});
it('adds another account with a password field and clears its token on save and reopen', async () => {
  const fetcher = setup(); await open();
  await userEvent.click(screen.getByRole('button', { name: 'Add connection' }));
  fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'GitHub second' } });
  fireEvent.change(screen.getByLabelText('MCP endpoint'), { target: { value: base.url } });
  const token = screen.getByLabelText('Bearer token') as HTMLInputElement;
  expect(token.type).toBe('password');
  fireEvent.change(token, { target: { value: 'secret-token' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByRole('heading', { name: 'GitHub second' });
  expect(fetcher.mock.calls.find(([path, opts]) => path === '/v1/me/connections' && opts?.method === 'POST')?.[1]?.body).toBe(JSON.stringify({ name: 'GitHub second', url: base.url, auth_type: 'bearer', token: 'secret-token' }));
  expect(document.body.textContent).not.toContain('secret-token');
  expect(screen.queryByLabelText('Bearer token')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await open();
  await userEvent.click(connection('GitHub second').getByRole('button', { name: 'Edit' }));
  expect((screen.getByLabelText('Bearer token') as HTMLInputElement).value).toBe('');
});
it('saves explicit per-account tool grants without granting newly discovered tools', async () => {
  const fetcher = setup(); await open();
  await userEvent.click(connection().getByRole('button', { name: 'Agent access' }));
  expect((screen.getByRole('checkbox', { name: /search/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('checkbox', { name: /write/ }) as HTMLInputElement).checked).toBe(false);
  await userEvent.click(screen.getByRole('checkbox', { name: /write/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Save access' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, opts]) => url === '/v1/me/connections/personal/grants' && opts?.method === 'PUT' && JSON.parse(opts.body as string).tools.join(',') === 'search,write')).toBe(true));
  await userEvent.click(connection('GitHub work').getByRole('button', { name: 'Agent access' }));
  expect((screen.getByRole('checkbox', { name: /search/ }) as HTMLInputElement).checked).toBe(false);
});
it('tests, disables and removes a connection with the latest revision', async () => {
  const fetcher = setup(); await open();
  await userEvent.click(connection().getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, opts]) => url.endsWith('/personal/discover') && JSON.parse(opts!.body as string).revision === 1)).toBe(true));
  await userEvent.click(connection().getByRole('button', { name: 'Disable' }));
  await connection().findByRole('button', { name: 'Enable' });
  await userEvent.click(connection().getByRole('button', { name: 'Delete' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'GitHub personal' })).toBeNull());
  expect(toast.getState().toasts.at(-1)).toMatchObject({ type: 'success', title: 'Connection deleted' });
  expect(fetcher.mock.calls.some(([url, opts]) => url.endsWith('/personal') && opts?.method === 'DELETE' && JSON.parse(opts.body as string).revision === 3)).toBe(true);
});
it('keeps edits after a failed save but never renders a secret echoed in an error', async () => {
  setup('secret-token'); await open();
  await userEvent.click(connection().getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'secret-token' } });
  fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Renamed' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  expect((await screen.findByRole('alert')).textContent).not.toContain('secret-token');
  expect((screen.getByLabelText('Connection name') as HTMLInputElement).value).toBe('Renamed');
  expect((screen.getByLabelText('Bearer token') as HTMLInputElement).value).toBe('');
});

it('refreshes through actor events, never polls, and unsubscribes on close', async () => {
  const fetcher = setup(); await open();
  const before = fetcher.mock.calls.length;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher.mock.calls.length).toBe(before);
  await act(async () => { await updates.get('actor:user')?.(); });
  expect(fetcher.mock.calls.length).toBe(before + 3);
  vi.useRealTimers();
  await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(updates.has('actor:user')).toBe(false));
  await open();
  expect(updates.has('actor:user')).toBe(true);
});

it('clears account data and an unsaved token when actor access is revoked', async () => {
  setup(); await open();
  await userEvent.click(connection().getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'secret-token' } });
  await act(async () => { revocations.get('actor:user')?.(); });
  expect(screen.queryByRole('heading', { name: 'GitHub personal' })).toBeNull();
  expect(screen.queryByLabelText('Bearer token')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add connection' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Your access changed');
});

it('shows a safe read failure and allows a user-initiated refresh', async () => {
  const fetcher = setup(); await open();
  fetcher.mockRejectedValueOnce(new Error('secret remote response'));
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Could not complete');
  expect(document.body.textContent).not.toContain('secret remote response');
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('can close after access is revoked during an in-flight mutation', async () => {
  const fetcher = setup(); await open();
  let finish!: (value: any) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await userEvent.click(connection().getByRole('button', { name: 'Test connection' }));
  await act(async () => { revocations.get('actor:user')?.(); });
  await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await act(async () => { finish({ ok: true, status: 200, json: async () => base }); });
  expect(screen.queryByRole('heading', { name: 'GitHub personal' })).toBeNull();
});

it('keeps the editor usable and shows each personal section as its own request finishes', async () => {
  let finishHistory!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/connection-calls')) return new Promise<Response>(resolve => { finishHistory = resolve; });
    if (url.endsWith('/connection-agents')) return new Promise<Response>(() => {});
    return Response.json({ items: [base] });
  }));
  render(<Connections userId="user" onClose={() => {}}/>);
  await screen.findByRole('heading', { name: base.name });
  await userEvent.click(connection().getByRole('button', { name: 'Agent access' }));
  expect(screen.getByText('Loading agents…')).toBeTruthy();
  expect(screen.getByText('Loading recent tool calls…')).toBeTruthy();
  expect(screen.queryByText('No tool calls yet.')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Add connection' }));
  await userEvent.type(screen.getByLabelText('Connection name'), 'Draft');
  await act(async () => finishHistory(Response.json({ items: [] })));
  expect(screen.getByText('No tool calls yet.')).toBeTruthy();
  expect(screen.getByLabelText('Connection name')).toHaveProperty('value', 'Draft');
});
