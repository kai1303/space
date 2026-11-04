import { socketCommand } from './socket-command.js';
import type { ChatEvent, ChatMessage, Page, RichDocument } from '@space/contracts';
import type { Socket } from 'socket.io-client';

export function mergeEvents(previous: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
  const events = new Map(previous.map(event => [event.sequence, event]));
  for (const event of incoming) events.set(event.sequence, event);
  return [...events.values()].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1);
}
export async function request<T>(path: string, body?: object, key?: string, method: 'POST' | 'PATCH' | 'DELETE' = 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/v1${path}`, {
    method: method === 'DELETE' ? 'DELETE' : body ? method : 'GET',
    credentials: 'same-origin', signal,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('space:session-expired'));
    throw new Error(result.error ?? 'Request failed');
  }
  return result as T;
}
export async function listAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let after: string | null = null;
  do {
    const page: Page<T> = await request(`${path}${path.includes('?') ? '&' : '?'}limit=100${after ? `&after=${after}` : ''}`);
    items.push(...page.items); after = page.next_cursor;
  } while (after);
  return items;
}
export function command<T>(socket: Socket, event: string, data: object): Promise<T> {
  return socketCommand<T>(socket, event, data);
}
export type MessageAttempt = { current?: { content: string; id: string } };
// Retain a failed attempt's ID, so retrying after a lost acknowledgment is safe.
export function messageSender(socket: Socket, channel: string, thread?: string, state: MessageAttempt = {}) {
  return async (text: string, document?: RichDocument, assetIds: string[] = [], broadcastConfirmed = false) => {
    const content = JSON.stringify({ text, document, ...(assetIds.length ? { asset_ids: assetIds } : {}) });
    if (state.current?.content !== content) state.current = { content, id: crypto.randomUUID() };
    const attempt = state.current;
    const saved = await command<ChatMessage>(socket, 'message.send', { channel_id: channel, text, ...(broadcastConfirmed ? { broadcast_confirmed: true } : {}), ...(assetIds.length ? { asset_ids: assetIds } : {}), ...(document ? { document } : {}), client_message_id: attempt.id, ...(thread ? { thread_id: thread } : {}) });
    if (state.current === attempt) state.current = undefined;
    return saved;
  };
}
