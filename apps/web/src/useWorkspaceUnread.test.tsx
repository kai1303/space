import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkspaceUnread } from './useWorkspaceUnread.js';

const clients = vi.hoisted(() => [] as any[]);
vi.mock('socket.io-client', () => ({ io: () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const client = {
    connected: false,
    on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
    connect: () => { client.connected = true; handlers.get('connect')?.(); },
    disconnect: vi.fn(() => { client.connected = false; }),
    subscriptions: 0,
    timeout: () => ({ emitWithAck: async () => { client.subscriptions++; return { data: {} }; } }),
    receive: (event: string, ...args: any[]) => handlers.get(event)?.(...args),
  };
  clients.push(client); return client;
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clients.length = 0; });
const snapshot = (workspace_id: string, unread_count: number) => ({ workspace_id, channels: [{ channel_id: 'channel', last_read_sequence: '0', latest_sequence: '8', unread_count }] });
it('does not overwrite a newer realtime count with an older focus response', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const hook = renderHook(() => useWorkspaceUnread('a'));
  act(() => { clients[0].receive('workspace.unread', snapshot('a', 8), vi.fn()); });
  await act(async () => { finish({ ok: true, json: async () => snapshot('a', 3) }); });
  expect(hook.result.current.channels[0]?.unread_count).toBe(8);
});
it('clears the previous workspace immediately and ignores its late HTTP and socket results', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn((path: string) => path.includes('/a/') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, json: async () => snapshot('b', 2) })));
  const hook = renderHook(({ workspace }) => useWorkspaceUnread(workspace), { initialProps: { workspace: 'a' } });
  act(() => { clients[0].receive('workspace.unread', snapshot('a', 8), vi.fn()); });
  expect(hook.result.current.channels[0]?.unread_count).toBe(8);
  hook.rerender({ workspace: 'b' });
  expect(hook.result.current.channels).toEqual([]);
  act(() => { clients[1].receive('workspace.unread', snapshot('b', 2), vi.fn()); });
  await waitFor(() => expect(hook.result.current.channels[0]?.unread_count).toBe(2));
  await act(async () => { finish({ ok: true, json: async () => snapshot('a', 99) }); clients[0].receive('workspace.unread', snapshot('a', 100), vi.fn()); });
  expect(hook.result.current.channels[0]?.unread_count).toBe(2);
  expect(clients[0].disconnect).toHaveBeenCalled();
});
it('refreshes focus on the socket stream and ignores HTTP results overtaking delayed socket snapshots', async () => {
  let finish!: (value: unknown) => void;
  const fetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const hook = renderHook(() => useWorkspaceUnread('a'));
  await act(async () => { finish({ ok: true, json: async () => snapshot('a', 0) }); });
  expect(hook.result.current.channels).toEqual([]);
  act(() => { clients[0].receive('workspace.unread', snapshot('a', 5), vi.fn()); });
  const subscriptions = clients[0].subscriptions;
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(clients[0].subscriptions).toBeGreaterThan(subscriptions);
  act(() => { clients[0].receive('workspace.unread', snapshot('a', 0), vi.fn()); });
  expect(hook.result.current.channels[0]?.unread_count).toBe(0);
});
