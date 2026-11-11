import type { Page } from '@space/contracts';
import type { SessionClient } from './session';

export class ApiError extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}
export const errorText = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Something went wrong';

const MAX_PAGES = 10; // 1,000 items per list.
export type Api = ReturnType<typeof createApi>;

export function createApi(session: Pick<SessionClient, 'fetch'>) {
  async function request<T>(path: string, body?: object, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST'): Promise<T> {
    const response = await session.fetch(`/v1${path}`, {
      method: method === 'DELETE' ? 'DELETE' : body ? method : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) throw new ApiError(response.status, (result as { error?: string } | undefined)?.error ?? 'request_failed');
    return result as T;
  }
  async function listAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: Page<T> = await request(`${path}${path.includes('?') ? '&' : '?'}limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      items.push(...result.items);
      after = result.next_cursor;
      if (!after) break;
    }
    return items;
  }
  return { request, listAll };
}
