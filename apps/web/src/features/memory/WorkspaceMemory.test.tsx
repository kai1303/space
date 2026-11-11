import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChannelSummary } from '@space/contracts';
import { MAX_CHANNELS, WorkspaceMemory } from './WorkspaceMemory.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const channel = (n: number, name: string, joined = true) => ({ id: uuid(n), name, joined, private: false, workspace_id: 'w' }) as unknown as ChannelSummary;
const thread = (n: number, ch: number) => ({ ref: { kind: 'thread', id: uuid(n) }, parent: { kind: 'channel', id: uuid(ch) }, summary: `Thread ${n}`, updated_at: '2026-11-11 10:00:00+00', children: { kind: 'session', count: 1 } });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function stub(threads: Record<number, unknown[]>, failing: number[] = []) {
  const fetch = vi.fn(async (path: string) => {
    const match = /\/channels\/([^/]+)\/memory\/layers/.exec(path);
    if (match) {
      const n = Number(match[1]!.slice(-12));
      if (failing.includes(n)) return response({ error: 'memory_disabled' }, 409);
      return response({ channel_id: match[1], nodes: threads[n] ?? [], next_cursor: null });
    }
    if (path.includes('/threads/')) return response({ node: thread(11, 1), context: { thread_id: uuid(11), through_sequence: '1', root: null, messages: [], memory: null, has_earlier_messages: false },
      sessions: [{ ref: { kind: 'session', id: uuid(900) }, parent: { kind: 'thread', id: uuid(11) }, summary: 'Run', updated_at: 'x', children: null, title: 'Run', agent: 'Codex', state: 'active' }], memory_chars: 0, limit: 6000 });
    return response({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('draws every joined channel and its threads in one graph', async () => {
  const fetch = stub({ 1: [thread(11, 1), thread(12, 1)], 2: [thread(21, 2)] });
  render(<WorkspaceMemory channels={[channel(1, 'general'), channel(2, 'payments'), channel(3, 'secret', false)]} onOpenChannel={() => {}} />);
  await screen.findByRole('button', { name: '#general, channel' });
  expect(screen.getByRole('button', { name: '#payments, channel' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '#secret, channel' })).toBeNull();
  expect(screen.getAllByRole('button', { name: /, thread$/ })).toHaveLength(3);
  expect(screen.getByRole('status').textContent).toBe('2 channels · 3 threads from the last 7 days');
  expect(fetch.mock.calls.some(([path]) => String(path).includes(uuid(3)))).toBe(false);
});

it('keeps a channel whose memory cannot be read, and expands a thread into sessions', async () => {
  stub({ 1: [thread(11, 1)] }, [2]);
  render(<WorkspaceMemory channels={[channel(1, 'general'), channel(2, 'off')]} onOpenChannel={() => {}} />);
  await screen.findByRole('button', { name: '#off, channel' });
  fireEvent.doubleClick(screen.getByRole('button', { name: 'Thread 11, thread' }));
  await screen.findByRole('button', { name: 'Codex, session' });
});

it('opens the channel from the channel details', async () => {
  stub({ 1: [] });
  const open = vi.fn();
  render(<WorkspaceMemory channels={[channel(1, 'general')]} onOpenChannel={open} />);
  fireEvent.click(await screen.findByRole('button', { name: '#general, channel' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open channel' }));
  expect(open).toHaveBeenCalledWith(uuid(1));
});

it('reads at most the channel cap', async () => {
  const fetch = stub({});
  render(<WorkspaceMemory channels={Array.from({ length: MAX_CHANNELS + 5 }, (_, i) => channel(i + 1, `c${i + 1}`))} onOpenChannel={() => {}} />);
  await screen.findByText(`Showing the first ${MAX_CHANNELS} channels you joined.`);
  await waitFor(() => expect(fetch.mock.calls.filter(([path]) => String(path).includes('/memory/layers'))).toHaveLength(MAX_CHANNELS));
});

it('explains what to do when no channel is joined', () => {
  render(<WorkspaceMemory channels={[channel(3, 'secret', false)]} onOpenChannel={() => {}} />);
  expect(screen.getByRole('heading', { name: 'No channel memory to show' })).toBeTruthy();
});
