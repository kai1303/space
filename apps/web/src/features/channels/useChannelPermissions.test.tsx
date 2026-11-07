import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useChannelPermissions } from './useChannelPermissions.js';
const mocks = vi.hoisted(() => ({ request: vi.fn(), listeners: new Map<string, { read: () => Promise<void>; revoke: (code: string) => void }>() }));
vi.mock('../../shared/api/request.js', () => ({ request: mocks.request }));
vi.mock('../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: (scope: string, id: string, read: () => Promise<void>, revoke: (code: string) => void) => { mocks.listeners.set(`${scope}:${id}`, { read, revoke }); void read(); return () => { mocks.listeners.delete(`${scope}:${id}`); }; } }));
afterEach(() => { cleanup(); mocks.request.mockReset(); mocks.listeners.clear(); });
const snapshot = { revision: '1', capabilities: { post: true, reply: false } };
it('fails closed until loaded and refreshes channel and workspace permission changes', async () => {
  mocks.request.mockResolvedValue(snapshot);
  const { result } = renderHook(() => useChannelPermissions('channel', 'workspace'));
  expect(result.current.snapshot).toBeUndefined();
  await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));
  mocks.request.mockResolvedValue({ ...snapshot, capabilities: { post: false, reply: true } });
  await act(async () => mocks.listeners.get('workspace:workspace')!.read());
  expect(result.current.snapshot?.capabilities.post).toBe(false);
  expect(result.current.snapshot?.capabilities.reply).toBe(true);
  mocks.request.mockRejectedValue(new Error('network_failure'));
  await act(async () => mocks.listeners.get('channel:channel')!.read());
  expect(result.current.snapshot).toBeUndefined();
  expect(result.current.error).toBeTruthy();
});
it('discards a late response after live revocation and channel replacement', async () => {
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ id }) => useChannelPermissions(id, 'workspace'), { initialProps: { id: 'old' } });
  act(() => mocks.listeners.get('channel:old')!.revoke('forbidden'));
  await act(async () => finish(snapshot));
  expect(result.current.snapshot).toBeUndefined();
  mocks.request.mockResolvedValue({ ...snapshot, revision: '2' });
  rerender({ id: 'new' });
  expect(result.current.snapshot).toBeUndefined();
  await waitFor(() => expect(result.current.snapshot?.revision).toBe('2'));
  expect(mocks.listeners.has('channel:old')).toBe(false);
});
it('does not subscribe or fetch for direct messages', () => {
  renderHook(() => useChannelPermissions(undefined, 'workspace'));
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.listeners.size).toBe(0);
});
it('fails closed for a malformed permission response', async () => {
  mocks.request.mockResolvedValue([]);
  const { result } = renderHook(() => useChannelPermissions('channel', 'workspace'));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.snapshot).toBeUndefined();
});
