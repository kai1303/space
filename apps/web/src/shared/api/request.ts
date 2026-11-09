import { sessionFetch } from './session-fetch.js';
import type { Page } from '@space/contracts';

export async function request<T>(path: string, body?: object, key?: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST', signal?: AbortSignal, expectedActor?: string): Promise<T> {
  const response = await sessionFetch(`/v1${path}`, {
    method: method === 'DELETE' ? 'DELETE' : body ? method : 'GET',
    credentials: 'same-origin', signal,
    headers: { ...(expectedActor ? { 'X-Expected-Actor': expectedActor } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
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
