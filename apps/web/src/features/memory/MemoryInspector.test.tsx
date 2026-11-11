import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryInspector } from './MemoryInspector.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ch = '00000000-0000-4000-8000-0000000000c1', th = '00000000-0000-4000-8000-000000000001';
const node = { ref: { kind: 'thread' as const, id: th }, parent: { kind: 'channel' as const, id: ch }, summary: 'Dedupe fix', updated_at: '2026-11-11 10:00:00+00', children: { kind: 'session' as const, count: 0 } };
const memory = (revision: number, content: string) => ({ revision, through_sequence: '3', content, summary: `Rev ${revision}`, source_message_ids: ['00000000-0000-4000-8000-000000000009'], producer_id: 'x', producer_name: 'Codex', created_at: '2026-11-11 10:00:00+00' });
const detail = (revision: number, content: string) => ({ node: { ...node, summary: `Rev ${revision}` }, context: { thread_id: th, through_sequence: '3', root: null, messages: [], memory: memory(revision, content), has_earlier_messages: false }, sessions: [], memory_chars: content.length, limit: 6000 });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

it('members see the memory but no Edit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(detail(3, '# Decisions\nDedupe'))));
  render(<MemoryInspector channel={ch} selection={{ kind: 'thread', node }} canManage={false} onDirtyChange={() => {}} />);
  expect(await screen.findByText(/Dedupe$/)).toBeTruthy();
  expect(screen.getByText(/rev 3 · Codex/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

it('a manager saves, and on 409 keeps the draft and shows the newer text', async () => {
  let reads = 0, saves = 0;
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return ++saves === 1 ? response({ error: 'thread_memory_conflict' }, 409) : response(memory(5, 'mine'));
    return response(++reads === 1 ? detail(3, 'old') : detail(4, 'someone else'));
  }));
  const dirty = vi.fn();
  render(<MemoryInspector channel={ch} selection={{ kind: 'thread', node }} canManage onDirtyChange={dirty} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Memory' }), { target: { value: 'mine' } });
  expect(dirty).toHaveBeenLastCalledWith(true);
  await userEvent.click(screen.getByRole('button', { name: 'Save memory' }));
  expect(await screen.findByText(/changed while you were editing/i)).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Memory' }) as HTMLTextAreaElement).value).toBe('mine');
  expect(screen.getByText('someone else')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Save memory' }));
  const body = JSON.parse(vi.mocked(fetch).mock.calls.filter(([, i]) => i?.method === 'POST').at(-1)![1]!.body as string);
  expect(body.revision).toBe(4);
  expect(await screen.findByText('Saved as revision 5.')).toBeTruthy();
  expect(dirty).toHaveBeenLastCalledWith(false);
});

it('ended sessions show no Edit', async () => {
  const session = { ref: { kind: 'session' as const, id: '00000000-0000-4000-8000-000000000900' }, parent: { kind: 'thread' as const, id: th }, summary: 'Run', updated_at: 'x', children: null, title: 'Run', agent: 'Codex', state: 'ended' as const };
  vi.stubGlobal('fetch', vi.fn(async () => response({ node: session, memory: null, messages: [], memory_chars: 0, limit: 6000 })));
  render(<MemoryInspector channel={ch} selection={{ kind: 'session', node: session, threadId: th }} canManage onDirtyChange={() => {}} />);
  await screen.findByText(/ended/);
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});
