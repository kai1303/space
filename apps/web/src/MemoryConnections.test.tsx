import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryConnections } from './MemoryConnections.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const connection = { id: 'key-id', name: 'Navigator', access: 'write', created_at: '2026-11-03T00:00:00Z' };
it('creates a scoped MCP key, shows configuration once, and revokes it', async () => {
  let exists = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => ({ ok: true, json: async () => {
    if (path.endsWith('/revoke')) { exists = false; return { revoked: true }; }
    if (options?.method === 'POST') { exists = true; return { connection, token: 'smem_disposable-secret' }; }
    return { items: exists ? [connection] : [] };
  } })));
  render(<MemoryConnections channel="first" enabled />);
  await screen.findByText('No MCP connections yet.');
  fireEvent.change(screen.getByRole('textbox', { name: 'Agent or Navigator name' }), { target: { value: 'Navigator' } });
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'MCP access' }), 'write');
  await userEvent.click(screen.getByRole('button', { name: 'Create MCP key' }));
  const config = await screen.findByRole('textbox', { name: 'MCP client configuration' });
  expect((config as HTMLTextAreaElement).value).toContain('/mcp/memory');
  expect((config as HTMLTextAreaElement).value).toContain('Bearer smem_disposable-secret');
  expect(screen.getByText(/shown only once/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Revoke Navigator' }));
  await screen.findByText('No MCP connections yet.');
  expect(screen.queryByRole('textbox', { name: 'MCP client configuration' })).toBeNull();
});

it('allows revoking existing keys while memory is off, and hides creation and secrets', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [connection] }) })));
  render(<MemoryConnections channel="first" enabled={false} />);
  await screen.findByRole('button', { name: 'Revoke Navigator' });
  expect(screen.queryByRole('button', { name: 'Create MCP key' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'MCP client configuration' })).toBeNull();
});

it('does not retain a late-issued secret after memory was disabled', async () => {
  let finish!: (result: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (_path: string, options?: RequestInit) => options?.method === 'POST'
    ? new Promise(resolve => { finish = resolve; }) : { ok: true, json: async () => ({ items: [] }) }));
  const view = render(<MemoryConnections channel="first" enabled />);
  await screen.findByText('No MCP connections yet.');
  fireEvent.change(screen.getByRole('textbox', { name: 'Agent or Navigator name' }), { target: { value: 'Navigator' } });
  await userEvent.click(screen.getByRole('button', { name: 'Create MCP key' }));
  view.rerender(<MemoryConnections channel="first" enabled={false} />);
  await act(async () => finish({ ok: true, json: async () => ({ connection, token: 'late-secret' }) }));
  view.rerender(<MemoryConnections channel="first" enabled />);
  expect(screen.queryByRole('textbox', { name: 'MCP client configuration' })).toBeNull();
});

it('immediately clears a hidden key from the DOM during normal motion', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_path: string, options?: RequestInit) => ({ ok: true, json: async () => options?.method === 'POST'
    ? { connection, token: 'smem_hide-secret' } : { items: [] } })));
  const view = render(<MemoryConnections channel="first" enabled />);
  await screen.findByText('No MCP connections yet.');
  fireEvent.change(screen.getByRole('textbox', { name: 'Agent or Navigator name' }), { target: { value: 'Navigator' } });
  await userEvent.click(screen.getByRole('button', { name: 'Create MCP key' }));
  const configuration = await screen.findByRole('textbox', { name: 'MCP client configuration' });
  fireEvent.click(screen.getByRole('button', { name: 'Hide key' }));
  expect(configuration.isConnected).toBe(false);
  expect(view.container.querySelector('.channel-memory-issued')).toBeNull();
});

it('sets agent memory permission separately and binds contribute-only keys to the selected installation', async () => {
  const calls: { path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (body) calls.push({ path, body });
    return { ok: true, json: async () => path.endsWith('/agents') ? { items: [{ id: 'agent-1', name: 'Research agent', access: 'none' }] }
      : path.endsWith('/agents/agent-1') ? { access: body.access }
      : body ? { connection: { id: 'bound-key', name: body.name, access: body.access, installation_id: body.installation_id }, token: 'bound-secret' }
      : { items: [] } };
  }));
  render(<MemoryConnections channel="first" enabled />);
  const permission = await screen.findByRole('combobox', { name: 'Memory access for Research agent' });
  expect((permission as HTMLSelectElement).value).toBe('none');
  await userEvent.selectOptions(permission, 'contribute');
  await screen.findByText('Memory permission updated.');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Bind key to installation' }), 'agent-1');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'MCP access' }), 'contribute');
  expect(screen.queryByRole('option', { name: 'Read conversations, read and write memory' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Create MCP key' }));
  await screen.findByRole('textbox', { name: 'MCP client configuration' });
  expect(calls[0]).toEqual({ path: '/v1/channels/first/memory/agents/agent-1', body: { access: 'contribute' } });
  expect(calls[1].body).toEqual({ name: 'Research agent', access: 'contribute', installation_id: 'agent-1' });
});
