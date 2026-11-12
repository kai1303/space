import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryGraph } from './MemoryGraph.js';

const updates = new Map<string, { read: () => unknown; revoke?: (code: string) => void }>();
vi.mock('../../shared/realtime/live-updates.js', () => ({
  subscribeUpdates: (scope: string, id: string, read: () => unknown, revoke?: (code: string) => void) => { updates.set(`${scope}:${id}`, { read, revoke }); return () => updates.delete(`${scope}:${id}`); },
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); updates.clear(); });

const ch = '00000000-0000-4000-8000-0000000000c1';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const thread = (n: number, summary = `Thread ${n}`) => ({ ref: { kind: 'thread', id: uuid(n) }, parent: { kind: 'channel', id: ch }, summary, updated_at: '2026-11-11 10:00:00+00', children: { kind: 'session', count: 1 } });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function stub(pages: { nodes: unknown[]; next_cursor: string | null }[]) {
  let summary = 'Thread 1';
  const fetch = vi.fn(async (path: string) => {
    if (path.includes('/memory/layers')) return response({ channel_id: ch, ...(path.includes('after=') ? pages[1] : { ...pages[0], nodes: pages[0]!.nodes.map((n: any, i) => i === 0 ? { ...n, summary } : n) }) });
    if (path.includes('/threads/')) return response({ node: thread(1), context: { thread_id: uuid(1), through_sequence: '1', root: null, messages: [], has_earlier_messages: false },
      sessions: [{ ref: { kind: 'session', id: uuid(900) }, parent: { kind: 'thread', id: uuid(1) }, summary: 'Run', updated_at: 'x', children: null, title: 'Run', agent: 'Codex', state: 'ended' }], related: [] });
    return response({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, rename: (s: string) => { summary = s; } };
}

it('shows the channel and first page, loads more without duplicates', async () => {
  stub([{ nodes: [thread(1), thread(2)], next_cursor: 'c1' }, { nodes: [thread(2), thread(3)], next_cursor: null }]);
  render(<MemoryGraph channel={ch} name="payments" onSelect={() => {}} onAccessLost={() => {}} />);
  await screen.findByRole('button', { name: '#payments, channel' });
  expect(screen.getAllByRole('button', { name: /, thread$/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Load more threads' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: /, thread$/ })).toHaveLength(3));
  expect(screen.queryByRole('button', { name: 'Load more threads' })).toBeNull();
});

it('expands a thread into sessions, collapses it, and keeps expansion across live refresh', async () => {
  const { rename } = stub([{ nodes: [thread(1)], next_cursor: null }, { nodes: [], next_cursor: null }]);
  render(<MemoryGraph channel={ch} name="payments" onSelect={() => {}} onAccessLost={() => {}} />);
  const node = await screen.findByRole('button', { name: 'Thread 1, thread' });
  fireEvent.doubleClick(node);
  await screen.findByRole('button', { name: 'Codex, session, ended' });
  rename('Renamed');
  await act(async () => { await updates.get(`channel:${ch}`)!.read(); });
  await screen.findByRole('button', { name: 'Renamed, thread' });
  expect(screen.getByRole('button', { name: 'Codex, session, ended' })).toBeTruthy();
  fireEvent.doubleClick(screen.getByRole('button', { name: 'Renamed, thread' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Codex, session, ended' })).toBeNull());
});

it('selecting the channel passes its header, and a live refresh sends the new one', async () => {
  let topic = 'Checkout';
  const header = () => ({ name: 'payments', topic, description: 'Refunds', top_topics: [] });
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.includes('/memory/layers')
    ? response({ channel_id: ch, channel: header(), nodes: [thread(1)], next_cursor: null }) : response({}, 404)));
  const onSelect = vi.fn();
  render(<MemoryGraph channel={ch} name="payments" onSelect={onSelect} onAccessLost={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '#payments, channel' }));
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith({ kind: 'channel', header: header() }));
  topic = 'Refunds first';
  await act(async () => { await updates.get(`channel:${ch}`)!.read(); });
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith({ kind: 'channel', header: header() }));
});

it('reports lost access when the live subscription is revoked', async () => {
  stub([{ nodes: [], next_cursor: null }, { nodes: [], next_cursor: null }]);
  const lost = vi.fn();
  render(<MemoryGraph channel={ch} name="payments" onSelect={() => {}} onAccessLost={lost} />);
  await screen.findByRole('button', { name: '#payments, channel' });
  act(() => updates.get(`channel:${ch}`)!.revoke!('not_found'));
  expect(lost).toHaveBeenCalled();
});
