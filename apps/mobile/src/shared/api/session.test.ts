import { SessionClient } from './session';

const BASE = 'https://space.test';
type Reply = { status?: number; body?: unknown; headers?: [string, string][] };
type Route = Reply | Reply[] | (() => Reply | Promise<Reply>);

// React Native joins repeated headers with ", "; this fake does the same.
const response = (reply: Reply) => ({
  status: reply.status ?? 200,
  ok: (reply.status ?? 200) < 300,
  headers: { get: (name: string) => {
    const values = (reply.headers ?? []).filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
    return values.length ? values.join(', ') : null;
  } },
  json: async () => reply.body ?? null,
}) as unknown as Response;

function server(routes: Record<string, Route>) {
  const calls: { path: string; init: RequestInit }[] = [];
  const http = jest.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.slice(BASE.length);
    calls.push({ path, init });
    const route = routes[path];
    if (!route) throw new Error(`Unexpected request ${path}`);
    const reply = typeof route === 'function' ? await route() : Array.isArray(route) ? route.shift()! : route;
    return response(reply);
  });
  return { calls, http: http as unknown as typeof fetch };
}
function memoryStore(value: string | null = null) {
  const store = {
    value,
    get: jest.fn(async () => store.value),
    set: jest.fn(async (next: string) => { store.value = next; }),
    clear: jest.fn(async () => { store.value = null; }),
  };
  return store;
}
const header = (call: { init: RequestInit }, name: string) => (call.init.headers as Record<string, string>)[name];
const session: Reply = {
  body: { user: { id: 'u1', name: 'Kai', email: 'kai@example.test' }, session: { id: 's1' } },
  headers: [['x-space-session-id', 's1']],
};
const stored = JSON.stringify({ 'better-auth.session_token': 'jwt1', 'space.refresh': 'r1' });
const authRequired: Reply = { status: 401, body: { error: 'unauthorized' }, headers: [['x-space-auth-required', '1']] };

it('signs in with explicit cookies and the server origin', async () => {
  const store = memoryStore();
  const { calls, http } = server({
    '/v1/auth/sign-in/email': { body: { user: { id: 'u1' } }, headers: [
      ['set-cookie', 'better-auth.session_token=jwt1; Max-Age=900; Path=/; HttpOnly; SameSite=Lax'],
      ['set-cookie', 'space.refresh=r1; Max-Age=2592000; Path=/v1/auth; HttpOnly; SameSite=Lax'],
    ] },
    '/v1/auth/get-session': session,
  });
  const client = new SessionClient(BASE, store, http, () => 0);
  await expect(client.signIn('kai@example.test', 'secret-password')).resolves.toEqual({ id: 'u1', name: 'Kai', email: 'kai@example.test' });
  expect(calls[0]!.init.credentials).toBe('omit');
  expect(header(calls[0]!, 'origin')).toBe(BASE);
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: 'kai@example.test', password: 'secret-password', rememberMe: true });
  expect(header(calls[1]!, 'cookie')).toBe('better-auth.session_token=jwt1; space.refresh=r1');
  expect(JSON.parse(store.value!)).toEqual({ 'better-auth.session_token': 'jwt1', 'space.refresh': 'r1' });
});

it('reports the server sign-in error', async () => {
  const { http } = server({ '/v1/auth/sign-in/email': { status: 401, body: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' } } });
  await expect(new SessionClient(BASE, memoryStore(), http, () => 0).signIn('a@b.test', 'x')).rejects.toThrow('Invalid email or password');
});

it('restores nothing without stored cookies', async () => {
  const { calls, http } = server({});
  await expect(new SessionClient(BASE, memoryStore(), http, () => 0).restore()).resolves.toBeNull();
  expect(calls).toHaveLength(0);
});

it('renews once after an access 401 and retries with rotated cookies', async () => {
  const { calls, http } = server({
    '/v1/auth/get-session': session,
    '/v1/me': [authRequired, { body: { id: 'u1' } }],
    '/v1/auth/refresh': { body: { sessionId: 's1' }, headers: [
      ['set-cookie', 'better-auth.session_token=jwt2; Max-Age=900; Path=/'],
      ['set-cookie', 'space.refresh=r2; Max-Age=2592000; Path=/v1/auth'],
    ] },
  });
  const client = new SessionClient(BASE, memoryStore(stored), http, () => 0);
  const renewed = jest.fn();
  client.on('renewed', renewed);
  await client.restore();
  expect((await client.fetch('/v1/me')).status).toBe(200);
  expect(header(calls.find(call => call.path === '/v1/auth/refresh')!, 'x-space-session-id')).toBe('s1');
  expect(header(calls.at(-1)!, 'cookie')).toBe('better-auth.session_token=jwt2; space.refresh=r2');
  expect(renewed).toHaveBeenCalledTimes(1);
});

it('clears the session when renewal is refused', async () => {
  const store = memoryStore(stored);
  const { http } = server({ '/v1/auth/get-session': session, '/v1/me': authRequired, '/v1/auth/refresh': { status: 401 } });
  const client = new SessionClient(BASE, store, http, () => 0);
  const expired = jest.fn();
  client.on('expired', expired);
  await client.restore();
  await expect(client.fetch('/v1/me')).rejects.toThrow('unauthorized');
  expect(store.value).toBeNull();
  expect(expired).toHaveBeenCalledTimes(1);
  expect(client.headers()).toEqual({ origin: BASE });
});

it('shares one renewal between concurrent callers', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { calls, http } = server({
    '/v1/auth/get-session': session,
    '/v1/auth/refresh': async () => { await gate; return { body: { sessionId: 's1' } }; },
  });
  const client = new SessionClient(BASE, memoryStore(stored), http, () => 0);
  await client.restore();
  const both = Promise.all([client.refresh(), client.refresh()]);
  release();
  await expect(both).resolves.toEqual([true, true]);
  expect(calls.filter(call => call.path === '/v1/auth/refresh')).toHaveLength(1);
});

it('renews before a request once the access deadline has passed', async () => {
  let now = 0;
  const { calls, http } = server({
    '/v1/auth/get-session': { ...session, headers: [...session.headers!, ['x-space-access-expires', '900']] },
    '/v1/auth/refresh': { body: { sessionId: 's1' } },
    '/v1/me': { body: { id: 'u1' } },
  });
  const client = new SessionClient(BASE, memoryStore(stored), http, () => now);
  await client.restore();
  now = 900_000;
  await client.fetch('/v1/me');
  expect(calls.map(call => call.path)).toEqual(['/v1/auth/get-session', '/v1/auth/refresh', '/v1/me']);
});

it('signs out locally when the server cannot be reached', async () => {
  const store = memoryStore(stored);
  const http = jest.fn(async (url: string) => {
    if (url.endsWith('/get-session')) return response(session);
    throw new TypeError('Network request failed');
  }) as unknown as typeof fetch;
  const client = new SessionClient(BASE, store, http, () => 0);
  await client.restore();
  await client.signOut();
  expect(store.value).toBeNull();
});
