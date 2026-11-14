import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryInspector } from './MemoryInspector.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ch = '00000000-0000-4000-8000-0000000000c1', th = '00000000-0000-4000-8000-000000000001';
const node = { ref: { kind: 'thread' as const, id: th }, parent: { kind: 'channel' as const, id: ch }, summary: 'Dedupe fix', updated_at: '2026-11-11 10:00:00+00', children: { kind: 'session' as const, count: 0 } };
const message = (n: number, text: string) => ({ id: `00000000-0000-4000-8000-00000000010${n}`, sequence: String(n), text, text_truncated: false, author: { id: '00000000-0000-4000-8000-0000000000a1', kind: 'human' as const }, attachments: [] });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

it('shows the root, the recent messages and the related ones, and offers no Edit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({
    node, sessions: [], related: [message(3, 'Duplicates came from retries')], topics: ['checkout retries'],
    facts: [{ id: 'f1', kind: 'decision', text: 'Dedupe on the idempotency key.', topic: 'checkout retries', message_ids: [message(2, '').id] }],
    context: { thread_id: th, through_sequence: '2', root: message(1, 'Fix duplicate charges'), messages: [message(2, 'Dedupe on the key')], has_earlier_messages: false },
  })));
  render(<MemoryInspector channel={ch} selection={{ kind: 'thread', node }} />);
  expect(await screen.findByText('Fix duplicate charges')).toBeTruthy();
  expect(screen.getByText('Dedupe on the key')).toBeTruthy();
  expect(screen.getByText('Duplicates came from retries')).toBeTruthy();
  expect(screen.getByText(/Related \(1\)/)).toBeTruthy();
  expect(screen.getByLabelText('Topics').textContent).toBe('checkout retries');
  expect(screen.getByText('Dedupe on the idempotency key.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('shows an ended session as history', async () => {
  const session = { ref: { kind: 'session' as const, id: '00000000-0000-4000-8000-000000000900' }, parent: { kind: 'thread' as const, id: th }, summary: 'Run', updated_at: 'x', children: null, title: 'Run', agent: 'Codex', state: 'ended' as const };
  vi.stubGlobal('fetch', vi.fn(async () => response({ node: session, messages: [message(4, 'Step 3 failed')], related: [] })));
  render(<MemoryInspector channel={ch} selection={{ kind: 'session', node: session, threadId: th }} />);
  expect(await screen.findByText(/ended/)).toBeTruthy();
  expect(screen.getByText('Step 3 failed')).toBeTruthy();
});

it('shows the channel topic and description as people typed them', () => {
  render(<MemoryInspector channel={ch} selection={{ kind: 'channel', header: { name: 'payments', topic: 'Checkout reliability', description: 'Refunds and retries', top_topics: [] } }} />);
  expect(screen.getByRole('heading', { name: '#payments' })).toBeTruthy();
  expect(screen.getByLabelText('Topic').textContent).toBe('Checkout reliability');
  expect(screen.getByLabelText('Description').textContent).toBe('Refunds and retries');
  expect(screen.queryByLabelText('Most discussed')).toBeNull();
});

it('shows the most discussed thread topics when the channel has no topic', () => {
  render(<MemoryInspector channel={ch} selection={{ kind: 'channel', header: { name: 'payments', topic: '', description: '', top_topics: ['refunds', 'retries'] } }} />);
  expect(screen.queryByLabelText('Topic')).toBeNull();
  expect(screen.queryByLabelText('Description')).toBeNull();
  expect(screen.getByLabelText('Most discussed').textContent).toBe('refunds · retries');
});

it('shows the error when memory cannot load', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'session_private' }, 403)));
  render(<MemoryInspector channel={ch} selection={{ kind: 'thread', node }} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
});

it('opens the selected thread while its messages are still loading', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const open = vi.fn();
  render(<MemoryInspector channel={ch} selection={{ kind: 'thread', node }} onOpenThread={open} />);
  expect(screen.getByText('Loading memory details…')).toBeTruthy();
  screen.getByRole('button', { name: /Open thread/ }).click();
  expect(open).toHaveBeenCalledWith(th);
});
