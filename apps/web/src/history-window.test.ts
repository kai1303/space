import { expect, it } from 'vitest';
import type { ChatMessage, MessagePage } from '@space/contracts';
import { appendLive, mergePage, HISTORY_LIMIT } from './history-window.js';

const message = (n: number): ChatMessage => ({ id: String(n), sequence: String(n), channel_id: 'channel', thread_id: 'thread', task_id: null, client_message_id: null, created_at: '2026-11-03T00:00:00Z', text: String(n), author: { kind: 'human', id: 'user', name: 'Kai' } });
const page = (start: number, end: number, older = true, newer = false): MessagePage => ({ messages: Array.from({ length: end - start + 1 }, (_, i) => message(start + i)), older_cursor: String(start), newer_cursor: String(end), has_older: older, has_newer: newer, event_cursor: String(end + 3) });

it('deduplicates overlapping pages and keeps chronological order across sequence gaps', () => {
  const result = mergePage(page(51, 100), page(1, 51, false, true), 'older');
  expect(result.messages.map(m => m.id)).toEqual(Array.from({ length: 100 }, (_, i) => String(i + 1)));
  expect(result.has_older).toBe(false);
  expect(result.has_newer).toBe(false);
});
it('evicts the far end and exposes a way back in both directions', () => {
  const older = mergePage(page(51, 550), page(1, 50, false, true), 'older');
  expect(older.messages).toHaveLength(HISTORY_LIMIT);
  expect([older.older_cursor, older.newer_cursor, older.has_newer]).toEqual(['1', '500', true]);
  const newer = mergePage(older, page(501, 550), 'newer');
  expect(newer.messages).toHaveLength(HISTORY_LIMIT);
  expect([newer.older_cursor, newer.newer_cursor, newer.has_older, newer.has_newer]).toEqual(['51', '550', true, false]);
});
it('does not evict what the user is reading when live messages fill the cache', () => {
  const result = appendLive(page(1, 500, false), [message(501)], false);
  expect(result.messages[0]?.id).toBe('1');
  expect(result.messages).toHaveLength(500);
  expect(result.has_newer).toBe(true);
  const pinned = appendLive(page(1, 500, false), [message(501)], true);
  expect([pinned.messages[0]?.id, pinned.newer_cursor, pinned.has_older]).toEqual(['2', '501', true]);
});
it('does not splice live messages onto a historical window with a gap', () => {
  const result = appendLive(page(1, 50, false, true), [message(1000)], true);
  expect(result.newer_cursor).toBe('50');
  expect(result.messages).toHaveLength(50);
});
it('keeps messages delivered during a latest-page request without retaining old history', () => {
  const result = mergePage(page(1, 105, false), page(51, 100), 'latest');
  expect(result.messages[0]?.id).toBe('51');
  expect(result.messages.at(-1)?.id).toBe('105');
  expect(result.messages.some(m => m.id === '101')).toBe(false); // snapshot watermark is 103
});
