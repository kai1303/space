import { afterEach, expect, it, vi } from 'vitest';
import { authFetch, sessionFetch } from './session-fetch.js';

const session = 's1';
const getSession = '/v1/auth/get-session';
const headers = (ms: number) => ({
  'x-space-access-expires': String(Math.floor((Date.now() + ms) / 1000)),
  'x-space-refresh-available': '1', 'x-space-session-id': session,
});

afterEach(async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  await authFetch('/v1/auth/sign-out');
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it('renews at the access deadline and stops after sign-out', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const fetch = vi.fn().mockImplementation(async (url: string) => {
    if (url === getSession) return new Response('{}', { headers: headers(900_000) });
    return Response.json({ sessionId: session }, { headers: headers(900_000) });
  });
  vi.stubGlobal('fetch', fetch);
  await authFetch(getSession);
  await vi.advanceTimersByTimeAsync(869_999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch.mock.lastCall?.[0]).toBe('/v1/auth/refresh');
  await authFetch('/v1/auth/sign-out');
  await vi.advanceTimersByTimeAsync(900_000);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('coalesces concurrent unauthorized requests and retries only requests rejected by the API auth guard', async () => {
  const attempts = new Map<string, number>();
  const fetch = vi.fn(async (url: string) => {
    attempts.set(url, (attempts.get(url) ?? 0) + 1);
    if (url === getSession) return new Response('{}', { headers: headers(900_000) });
    if (url === '/v1/auth/refresh') return Response.json({ sessionId: session }, { headers: headers(900_000) });
    if (url === '/v1/denied') return new Response('{}', { status: 401 });
    return attempts.get(url) === 1
      ? new Response('{}', { status: 401, headers: { 'x-space-auth-required': '1' } })
      : new Response('{}');
  });
  vi.stubGlobal('fetch', fetch);
  await authFetch(getSession);
  const results = await Promise.all(['/v1/a', '/v1/b'].map(url => sessionFetch(url, { method: 'POST', body: '{}' })));
  expect(results.map(result => result.status)).toEqual([200, 200]);
  expect((await sessionFetch('/v1/denied')).status).toBe(401);
  expect(attempts.get('/v1/auth/refresh')).toBe(1);
  expect(attempts.get('/v1/denied')).toBe(1);
});
