# Space Mobile App (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `apps/mobile`, an Expo app where a signed-in member picks a workspace, opens a joined channel, reads history and sends and receives messages live.

**Architecture:** A native client of the existing `apps/server` API with no server change. A `SessionClient` keeps Better Auth cookies in a jar saved to `expo-secure-store` and sends them with `Origin` equal to the server's own origin. One socket.io session per signed-in user, owned by `app/(app)/_layout.tsx`, subscribes to the open channel with the last event cursor, so the server replays anything missed while the app was in the background.

**Tech Stack:** Expo (latest SDK chosen by `create-expo-app`), React Native, Expo Router, TypeScript, socket.io-client 4, expo-secure-store, expo-crypto, Jest with `jest-expo`, React Native Testing Library. Types come from `@space/contracts` with `import type` only.

**Spec:** `docs/superpowers/specs/2026-11-11-mobile-app-design.md`

---

## File map

| File | Job |
|---|---|
| `apps/mobile/package.json`, `app.json`, `tsconfig.json`, `jest.config.js`, `expo-env.d.ts`, `.env.example` | App setup |
| `apps/mobile/src/shared/config.ts` | Validate `EXPO_PUBLIC_SPACE_URL` |
| `apps/mobile/src/shared/api/cookie-jar.ts` | Parse `Set-Cookie`, build `Cookie` |
| `apps/mobile/src/shared/api/session.ts` | Sign in, restore, renew, expire, authenticated fetch |
| `apps/mobile/src/shared/api/request.ts` | JSON requests, paging, error text |
| `apps/mobile/src/shared/api/useLoad.ts` | Load-once hook with reload |
| `apps/mobile/src/shared/storage/secure-store.ts` | Keychain-backed `Store` |
| `apps/mobile/src/shared/realtime/socket-session.ts` | socket.io lifecycle, renewal, serialized commands |
| `apps/mobile/src/shared/realtime/RealtimeProvider.tsx` | Owns the socket, reacts to `AppState` |
| `apps/mobile/src/shared/ui/Centered.tsx`, `Row.tsx` | Small shared views |
| `apps/mobile/src/features/auth/AuthProvider.tsx`, `SignInScreen.tsx`, `SignOutButton.tsx` | Auth state and screens |
| `apps/mobile/src/features/workspaces/WorkspaceList.tsx` | Workspace picker |
| `apps/mobile/src/features/channels/channels.ts`, `ChannelList.tsx` | Channel filter and list |
| `apps/mobile/src/features/chat/history-window.ts` | Copy of the web history window |
| `apps/mobile/src/features/chat/outbox.ts` | Pending, failed, confirmed sends |
| `apps/mobile/src/features/chat/useChannel.ts`, `ChannelScreen.tsx` | Conversation logic and view |
| `apps/mobile/app/**` | Expo Router routes |
| `tests/integration/auth.test.ts` | Native-client server contract |
| `package.json` (root) | `mobile` script |

Rules for every task: relative imports with no file extension inside `apps/mobile`; `import type` for anything from `@space/contracts`; `shared` never imports `features`; nothing under `src` imports `app`.

---

### Task 1: Scaffold the Expo app

**Files:**
- Create: `apps/mobile/*` (from template), `apps/mobile/jest.config.js`, `apps/mobile/expo-env.d.ts`, `apps/mobile/.env.example`, `apps/mobile/app/_layout.tsx`, `apps/mobile/app/index.tsx`
- Modify: `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/tsconfig.json`, `apps/mobile/.gitignore`, `package.json` (root)
- Delete: `apps/mobile/App.tsx`, `apps/mobile/index.ts`

- [ ] **Step 1: Create the app from the template**

Run from the repo root:

```bash
pnpm create expo-app@latest apps/mobile --template blank-typescript --no-install
rm apps/mobile/App.tsx apps/mobile/index.ts
```

Expected: `apps/mobile` contains `package.json`, `app.json`, `tsconfig.json`, `assets/`, `.gitignore`. If the template created `apps/mobile/.git`, remove that directory.

- [ ] **Step 2: Set package fields and scripts**

Run in `apps/mobile`:

```bash
npm pkg set name=@space/mobile private=true main=expo-router/entry version=0.0.1
npm pkg set scripts.start="expo start" scripts.ios="expo start --ios" scripts.android="expo start --android" scripts.typecheck="tsc --noEmit" scripts.test="jest"
npm pkg delete scripts.web
```

- [ ] **Step 3: Install dependencies**

Run in `apps/mobile`:

```bash
pnpm install
pnpm exec expo install expo-router expo-linking expo-constants expo-status-bar react-native-safe-area-context react-native-screens expo-secure-store expo-crypto
pnpm add socket.io-client@^4.8.1 @space/contracts@workspace:*
pnpm exec expo install jest-expo jest @types/jest @testing-library/react-native -- -D
pnpm add -D @types/node@22
```

Expected: all commands exit 0. `package.json` lists `@space/contracts` as `workspace:*`.

- [ ] **Step 4: Configure `app.json`**

Keep the template's `icon`, `splash`, `ios`, `android` and asset fields. Set these keys inside `"expo"`:

```json
{
  "name": "Space",
  "slug": "space",
  "scheme": "space",
  "version": "0.0.1",
  "userInterfaceStyle": "automatic",
  "plugins": ["expo-router", "expo-secure-store"]
}
```

Remove the `"web"` block if present.

- [ ] **Step 5: Write `tsconfig.json`, `expo-env.d.ts`, `jest.config.js`, `.env.example`**

`apps/mobile/tsconfig.json`:

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["jest", "node"]
  },
  "include": ["**/*.ts", "**/*.tsx", "expo-env.d.ts"]
}
```

`apps/mobile/expo-env.d.ts`:

```ts
/// <reference types="expo/types" />
```

Delete the `expo-env.d.ts` line from `apps/mobile/.gitignore`, so CI typechecks without running `expo start`.

`apps/mobile/jest.config.js`:

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/*.test.ts?(x)'],
};
```

`apps/mobile/.env.example`:

```
# Copy to .env.local. Must be a server origin the device can reach,
# and that origin must be BETTER_AUTH_URL or listed in AUTH_TRUSTED_ORIGINS.
EXPO_PUBLIC_SPACE_URL=http://127.0.0.1:3000
```

- [ ] **Step 6: Add a first route**

`apps/mobile/app/_layout.tsx`:

```tsx
import { Stack } from 'expo-router';

export default function RootLayout() {
  return <Stack />;
}
```

`apps/mobile/app/index.tsx` (replaced in Task 9):

```tsx
import { Text, View } from 'react-native';

export default function Home() {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text>Space</Text></View>;
}
```

- [ ] **Step 7: Add the root script**

In the root `package.json` `scripts`, after `"desktop:make"`, add:

```json
"mobile": "pnpm --filter @space/mobile start",
```

- [ ] **Step 8: Prove Metro works with this pnpm workspace**

Run in `apps/mobile`:

```bash
pnpm exec expo-doctor
pnpm exec expo export --platform ios --output-dir dist
pnpm typecheck
```

Expected: `expo-doctor` reports no failed checks; export writes `dist/` (already gitignored by the template); typecheck exits 0.

**Checkpoint:** if Metro cannot resolve packages under pnpm 8.10.3, stop and report the error. Do not add `node-linker=hoisted` to the root `.npmrc` or upgrade pnpm without approval, because both change the whole monorepo.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile package.json pnpm-lock.yaml
git commit -m "feat(mobile): scaffold Expo app"
```

---

### Task 2: Server URL config

**Files:**
- Create: `apps/mobile/src/shared/config.ts`
- Test: `apps/mobile/src/shared/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { serverConfig } from './config';

it('accepts an https origin and normalizes it', () => {
  expect(serverConfig('https://Space.Example.com/', false)).toEqual({ baseUrl: 'https://space.example.com' });
  expect(serverConfig('https://space.example.com:443', false)).toEqual({ baseUrl: 'https://space.example.com' });
});

it('allows http only in development', () => {
  expect(serverConfig('http://192.168.1.20:3000', true)).toEqual({ baseUrl: 'http://192.168.1.20:3000' });
  expect(() => serverConfig('http://192.168.1.20:3000', false)).toThrow('https');
});

it('rejects a missing value, a path or credentials', () => {
  expect(() => serverConfig(undefined, true)).toThrow('EXPO_PUBLIC_SPACE_URL');
  expect(() => serverConfig('https://space.example.com/api', false)).toThrow('EXPO_PUBLIC_SPACE_URL');
  expect(() => serverConfig('https://user:pw@space.example.com', false)).toThrow('EXPO_PUBLIC_SPACE_URL');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @space/mobile test -- src/shared/config.test.ts`
Expected: FAIL, `Cannot find module './config'`.

- [ ] **Step 3: Implement**

```ts
// React Native's URL class lacks most getters, so parse the origin directly.
const ORIGIN = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?\/?$/;

export function serverConfig(
  value: string | undefined = process.env.EXPO_PUBLIC_SPACE_URL,
  development: boolean = __DEV__,
) {
  const match = value ? ORIGIN.exec(value.trim()) : null;
  if (!match) throw new Error('EXPO_PUBLIC_SPACE_URL must be a server origin such as https://space.example.com');
  const [, scheme, host, port = ''] = match;
  if (scheme !== 'https' && !development) throw new Error('EXPO_PUBLIC_SPACE_URL must use https outside development');
  const defaultPort = (scheme === 'https' && port === ':443') || (scheme === 'http' && port === ':80');
  // This must equal the server's own origin string, which Origin checks compare exactly.
  return { baseUrl: `${scheme}://${host!.toLowerCase()}${defaultPort ? '' : port}` };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @space/mobile test -- src/shared/config.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/shared/config.ts apps/mobile/src/shared/config.test.ts
git commit -m "feat(mobile): validate server URL"
```

---

### Task 3: Cookie jar

**Files:**
- Create: `apps/mobile/src/shared/api/cookie-jar.ts`
- Test: `apps/mobile/src/shared/api/cookie-jar.test.ts`

React Native joins several `Set-Cookie` headers into one string separated by `, `. `Expires` dates also contain `, `, so the split only happens before a `name=`.

- [ ] **Step 1: Write the failing test**

```ts
import { applySetCookie, cookieHeader } from './cookie-jar';

it('reads several cookies from one joined header', () => {
  const jar = applySetCookie({}, 'better-auth.session_token=jwt1; Max-Age=900; Path=/; HttpOnly, space.refresh=r1; Expires=Wed, 11 Dec 2026 07:28:00 GMT; Path=/v1/auth');
  expect(jar).toEqual({ 'better-auth.session_token': 'jwt1', 'space.refresh': 'r1' });
});

it('replaces and removes cookies', () => {
  expect(applySetCookie({ a: '1', b: '2', c: '3' }, 'a=9; Path=/, b=; Path=/, c=3; Max-Age=0')).toEqual({ a: '9' });
});

it('ignores malformed entries and leaves the input unchanged', () => {
  const input = { a: '1' };
  expect(applySetCookie(input, '=x, novalue')).toEqual({ a: '1' });
  expect(input).toEqual({ a: '1' });
});

it('builds a Cookie header', () => {
  expect(cookieHeader({ a: '1', b: '2' })).toBe('a=1; b=2');
  expect(cookieHeader({})).toBe('');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @space/mobile test -- src/shared/api/cookie-jar.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
export type Cookies = Record<string, string>;

// Split a joined Set-Cookie header only where a new `name=` starts.
const entries = (header: string) => header.split(/,\s*(?=[^;,\s=]+=)/);

export function applySetCookie(jar: Cookies, header: string | null): Cookies {
  if (!header) return jar;
  const next = { ...jar };
  for (const entry of entries(header)) {
    const [pair = '', ...attributes] = entry.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some(attribute => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(attribute));
    if (!value || expired) delete next[name];
    else next[name] = value;
  }
  return next;
}

export function cookieHeader(jar: Cookies): string {
  return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @space/mobile test -- src/shared/api/cookie-jar.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/shared/api/cookie-jar.ts apps/mobile/src/shared/api/cookie-jar.test.ts
git commit -m "feat(mobile): add cookie jar"
```

---

### Task 4: Session client

**Files:**
- Create: `apps/mobile/src/shared/api/session.ts`
- Test: `apps/mobile/src/shared/api/session.test.ts`

Mirrors `apps/web/src/shared/api/session-fetch.ts`: renew before a request after the access deadline, renew once on a 401 carrying `x-space-auth-required`, share one renewal, and check that the renewed session id matches.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @space/mobile test -- src/shared/api/session.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { applySetCookie, cookieHeader, type Cookies } from './cookie-jar';

export type Store = { get(): Promise<string | null>; set(value: string): Promise<void>; clear(): Promise<void> };
export type SessionUser = { id: string; name: string; email: string };
type SessionEvent = 'expired' | 'renewed';
const json = { 'content-type': 'application/json' };

// A native client: cookies live in our jar, never in the platform cookie store.
export class SessionClient {
  private jar: Cookies = {};
  private loaded = false;
  private expires = 0;
  private sessionId: string | undefined;
  private pending: Promise<boolean> | undefined;
  private readonly listeners: Record<SessionEvent, Set<() => void>> = { expired: new Set(), renewed: new Set() };

  constructor(
    private readonly base: string,
    private readonly store: Store,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  on(event: SessionEvent, listener: () => void): () => void {
    this.listeners[event].add(listener);
    return () => { this.listeners[event].delete(listener); };
  }

  // Native apps are not browsers, so sending the server's own origin gives up no CSRF protection.
  headers(): Record<string, string> {
    const cookie = cookieHeader(this.jar);
    return cookie ? { origin: this.base, cookie } : { origin: this.base };
  }

  async restore(): Promise<SessionUser | null> {
    await this.load();
    if (!cookieHeader(this.jar)) return null;
    let response = await this.send('/v1/auth/get-session');
    if (response.status >= 500) throw new Error('Space is not reachable right now.');
    if (response.ok && response.headers.get('x-space-refresh-available') && !response.headers.get('x-space-session-id')) {
      if (await this.refresh()) response = await this.send('/v1/auth/get-session');
    }
    const body = response.ok ? await response.json().catch(() => null) as { user?: SessionUser; session?: { id: string } } | null : null;
    if (!body?.user) { await this.clear(); return null; }
    this.sessionId = response.headers.get('x-space-session-id') ?? body.session?.id;
    return { id: body.user.id, name: body.user.name, email: body.user.email };
  }

  async signIn(email: string, password: string): Promise<SessionUser> {
    await this.load();
    await this.clear();
    const response = await this.send('/v1/auth/sign-in/email', {
      method: 'POST', headers: json, body: JSON.stringify({ email, password, rememberMe: true }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string } | null;
      throw new Error(body?.message ?? 'Sign in failed');
    }
    const user = await this.restore();
    if (!user) throw new Error('Sign in failed');
    return user;
  }

  async signOut(): Promise<void> {
    try { await this.send('/v1/auth/sign-out', { method: 'POST', headers: json, body: '{}' }); }
    catch { /* Local sign-out must still succeed offline. */ }
    await this.expire();
  }

  async expire(): Promise<void> {
    await this.clear();
    for (const listener of [...this.listeners.expired]) listener();
  }

  refresh(): Promise<boolean> {
    if (this.pending) return this.pending;
    const before = this.sessionId;
    const promise = (async () => {
      const response = await this.send('/v1/auth/refresh', {
        method: 'POST', headers: { ...json, ...(before ? { 'x-space-session-id': before } : {}) }, body: '{}',
      });
      if (response.status === 401) return false;
      if (!response.ok) throw new Error('Could not renew your session. Please try again.');
      const { sessionId } = await response.json() as { sessionId: string };
      if (before && sessionId !== before) return false;
      this.sessionId = sessionId;
      for (const listener of [...this.listeners.renewed]) listener();
      return true;
    })().finally(() => { if (this.pending === promise) this.pending = undefined; });
    this.pending = promise;
    return promise;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.expires && this.now() >= this.expires - 5000 && !(await this.refresh())) return this.unauthorized();
    const response = await this.send(path, init);
    if (response.status !== 401) return response;
    if (response.headers.get('x-space-auth-required') && this.sessionId && await this.refresh()) {
      const retried = await this.send(path, init);
      if (retried.status !== 401) return retried;
    }
    return this.unauthorized();
  }

  private async unauthorized(): Promise<never> {
    await this.expire();
    throw new Error('unauthorized');
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.http(`${this.base}${path}`, {
      ...init, credentials: 'omit',
      headers: { ...(init.headers as Record<string, string> | undefined), ...this.headers() },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) { this.jar = applySetCookie(this.jar, setCookie); await this.save(); }
    const expires = Number(response.headers.get('x-space-access-expires'));
    if (expires) {
      const serverTime = Date.parse(response.headers.get('date') ?? '');
      this.expires = Number.isFinite(serverTime) ? this.now() + expires * 1000 - serverTime : expires * 1000;
    }
    return response;
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.store.get();
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      this.jar = parsed && typeof parsed === 'object'
        ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Cookies
        : {};
    } catch { this.jar = {}; }
  }

  private save() {
    return cookieHeader(this.jar) ? this.store.set(JSON.stringify(this.jar)) : this.store.clear();
  }

  private async clear() {
    this.jar = {};
    this.sessionId = undefined;
    this.expires = 0;
    await this.store.clear();
  }
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @space/mobile test -- src/shared/api/session.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/shared/api/session.ts apps/mobile/src/shared/api/session.test.ts
git commit -m "feat(mobile): add native session client"
```

---

### Task 5: Requests, secure store, load hook

**Files:**
- Create: `apps/mobile/src/shared/api/request.ts`, `apps/mobile/src/shared/api/useLoad.ts`, `apps/mobile/src/shared/storage/secure-store.ts`
- Test: `apps/mobile/src/shared/api/request.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { createApi, errorText } from './request';

const reply = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body }) as unknown as Response;

it('sends JSON and returns the body', async () => {
  const fetch = jest.fn(async (_path: string, _init?: RequestInit) => reply(201, { id: 'w1' }));
  await expect(createApi({ fetch }).request('/workspaces', { name: 'A' })).resolves.toEqual({ id: 'w1' });
  expect(fetch).toHaveBeenCalledWith('/v1/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"A"}' });
});

it('throws the server error code with its status', async () => {
  const fetch = jest.fn(async (_path: string, _init?: RequestInit) => reply(403, { error: 'forbidden' }));
  await expect(createApi({ fetch }).request('/channels/c1/messages')).rejects.toMatchObject({ status: 403, message: 'forbidden' });
});

it('pages through lists and stops at the page bound', async () => {
  const fetch = jest.fn(async (path: string, _init?: RequestInit) => reply(200, { items: [path], next_cursor: 'next' }));
  expect(await createApi({ fetch }).listAll('/workspaces')).toHaveLength(10);
  expect(fetch.mock.calls[1]![0]).toBe('/v1/workspaces?limit=100&after=next');
});

it('formats error codes for people', () => {
  expect(errorText(new Error('not_found'))).toBe('not found');
  expect(errorText('x')).toBe('Something went wrong');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @space/mobile test -- src/shared/api/request.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `request.ts`**

```ts
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
```

- [ ] **Step 4: Implement `secure-store.ts`**

```ts
import * as SecureStore from 'expo-secure-store';
import type { Store } from '../api/session';

const KEY = 'space.session.cookies';
const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const secureStore: Store = {
  get: () => SecureStore.getItemAsync(KEY, options),
  set: value => SecureStore.setItemAsync(KEY, value, options),
  clear: () => SecureStore.deleteItemAsync(KEY, options),
};
```

- [ ] **Step 5: Implement `useLoad.ts`**

```ts
import { useCallback, useEffect, useState, type DependencyList } from 'react';
import { errorText } from './request';

export function useLoad<T>(load: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    load().then(
      value => { if (alive) setData(value); },
      reason => { if (alive) setError(errorText(reason)); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // `load` is recreated each render; callers list what it reads in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);
  return { data, error, loading, reload };
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @space/mobile test -- src/shared/api && pnpm --filter @space/mobile typecheck`
Expected: all passed, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/shared
git commit -m "feat(mobile): add API requests and secure session storage"
```

---

### Task 6: Realtime session

**Files:**
- Create: `apps/mobile/src/shared/realtime/socket-session.ts`
- Test: `apps/mobile/src/shared/realtime/socket-session.test.ts`

The server answers `busy` to a second command in flight on one socket, so commands queue. Live receipts stay off (no `auth.live_receipts`), so every event is acknowledged with a plain `ack()`.

- [ ] **Step 1: Write the failing test**

```ts
import { createRealtime } from './socket-session';

type Handler = (...args: any[]) => void;
class FakeSocket {
  connected = false;
  active = false;
  io = { opts: {} as { extraHeaders?: Record<string, string> } };
  connects: (Record<string, string> | undefined)[] = [];
  sent: string[] = [];
  replies: ((event: string) => Promise<unknown>)[] = [];
  private handlers = new Map<string, Set<Handler>>();
  on(event: string, handler: Handler) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event)!.add(handler); return this; }
  off(event: string, handler: Handler) { this.handlers.get(event)?.delete(handler); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  fire(event: string, ...args: unknown[]) { for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args); }
  connect() { this.connects.push(this.io.opts.extraHeaders); this.active = true; return this; }
  disconnect() { this.active = false; if (this.connected) { this.connected = false; this.fire('disconnect', 'io client disconnect'); } return this; }
  open() { this.connected = true; this.fire('connect'); }
  timeout() { return { emitWithAck: (event: string) => { this.sent.push(event); return (this.replies.shift() ?? (async () => ({ data: 'ok' })))(event); } }; }
}
function fakeAuth() {
  const listeners = { renewed: new Set<() => void>(), expired: new Set<() => void>() };
  const auth = {
    cookie: 'a=1', refreshResult: true,
    headers: () => ({ origin: 'https://space.test', cookie: auth.cookie }),
    refresh: jest.fn(async () => {
      if (auth.refreshResult) { auth.cookie = 'a=2'; listeners.renewed.forEach(listener => listener()); }
      return auth.refreshResult;
    }),
    expire: jest.fn(async () => { listeners.expired.forEach(listener => listener()); }),
    on: (event: 'renewed' | 'expired', listener: () => void) => { listeners[event].add(listener); return () => { listeners[event].delete(listener); }; },
  };
  return auth;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
  const socket = new FakeSocket();
  const auth = fakeAuth();
  return { socket, auth, realtime: createRealtime('https://space.test', auth, () => socket as never) };
}

it('connects with the session headers', () => {
  const { socket, realtime } = setup();
  realtime.start();
  expect(socket.connects).toEqual([{ origin: 'https://space.test', cookie: 'a=1' }]);
});

it('renews once on unauthorized and reconnects with the new cookie', async () => {
  const { socket, auth, realtime } = setup();
  realtime.start();
  socket.fire('connect_error', new Error('unauthorized'));
  await settle();
  expect(auth.refresh).toHaveBeenCalledTimes(1);
  expect(socket.connects.at(-1)).toEqual({ origin: 'https://space.test', cookie: 'a=2' });
});

it('expires the session after a second unauthorized without a connect', async () => {
  const { socket, auth, realtime } = setup();
  realtime.start();
  socket.fire('connect_error', new Error('unauthorized'));
  await settle();
  socket.fire('chat.error', { error: 'unauthorized' });
  await settle();
  expect(auth.expire).toHaveBeenCalledTimes(1);
  realtime.start();
  expect(socket.connects).toHaveLength(2);
});

it('sends commands one at a time', async () => {
  const { socket, realtime } = setup();
  realtime.start(); socket.open();
  let release!: (value: unknown) => void;
  socket.replies.push(() => new Promise(resolve => { release = resolve; }), async () => ({ data: 'second' }));
  const first = realtime.command('a', {});
  const second = realtime.command('b', {});
  await settle();
  expect(socket.sent).toEqual(['a']);
  release({ data: 'first' });
  await expect(first).resolves.toBe('first');
  await expect(second).resolves.toBe('second');
});

it('rejects commands while disconnected and surfaces server errors', async () => {
  const { socket, realtime } = setup();
  await expect(realtime.command('a', {})).rejects.toThrow('Reconnecting');
  realtime.start(); socket.open();
  socket.replies.push(async () => ({ error: 'forbidden' }));
  await expect(realtime.command('a', {})).rejects.toThrow('forbidden');
});

it('acknowledges events after the handler runs', () => {
  const { socket, realtime } = setup();
  const seen: unknown[] = [];
  const off = realtime.on('chat.events', value => { seen.push(value); });
  const ack = jest.fn();
  socket.fire('chat.events', { n: 1 }, ack);
  expect(seen).toEqual([{ n: 1 }]);
  expect(ack).toHaveBeenCalledTimes(1);
  off();
  socket.fire('chat.events', { n: 2 });
  expect(seen).toHaveLength(1);
});

it('stop disconnects and start reconnects', () => {
  const { socket, realtime } = setup();
  realtime.start(); socket.open();
  realtime.stop();
  expect(socket.connected).toBe(false);
  realtime.start();
  expect(socket.connects).toHaveLength(2);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @space/mobile test -- src/shared/realtime/socket-session.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import type { SessionClient } from '../api/session';

export type RealtimeAuth = Pick<SessionClient, 'headers' | 'refresh' | 'expire' | 'on'>;
type Connect = (url: string, options: Partial<ManagerOptions & SocketOptions>) => Socket;
export type Realtime = ReturnType<typeof createRealtime>;
const MAX_PENDING = 128;

export function createRealtime(base: string, auth: RealtimeAuth, connect: Connect = io) {
  const socket = connect(base, {
    transports: ['websocket'], autoConnect: false,
    reconnectionDelay: 1000, reconnectionDelayMax: 30_000, randomizationFactor: 0.5,
    extraHeaders: auth.headers(),
  });
  let wanted = false, closed = false, restoring = false, triedRefresh = false, delay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<unknown> = Promise.resolve(), pending = 0, generation = 0;

  const open = () => {
    if (closed || !wanted || socket.connected || socket.active) return;
    // Engine.IO reads these on every new transport, so a renewed cookie applies on reconnect.
    socket.io.opts.extraHeaders = auth.headers();
    socket.connect();
  };
  // Bounded backoff for cases socket.io does not retry itself.
  const later = () => {
    if (retry || closed || !wanted) return;
    const wait = delay * (0.75 + Math.random() * 0.5);
    delay = Math.min(delay * 2, 30_000);
    retry = setTimeout(() => { retry = undefined; open(); }, wait);
  };
  const restore = () => {
    if (closed || restoring) return;
    if (triedRefresh) { void auth.expire(); return; }
    restoring = true; triedRefresh = true;
    socket.disconnect();
    auth.refresh()
      .then(ok => { if (!ok) void auth.expire(); }) // On success the 'renewed' listener reconnects.
      .catch(() => { triedRefresh = false; later(); })
      .finally(() => { restoring = false; });
  };

  socket.on('connect', () => { triedRefresh = false; delay = 1000; clearTimeout(retry); retry = undefined; });
  socket.on('disconnect', (reason: string) => { generation++; if (reason === 'io server disconnect' && !restoring) later(); });
  socket.on('connect_error', (error: Error) => {
    if (error.message === 'unauthorized') restore();
    else if (!socket.active) later(); // Middleware rejections are not retried by socket.io.
  });
  socket.on('chat.error', (error: { error?: string } | undefined) => { if (error?.error === 'unauthorized') restore(); });
  const offRenewed = auth.on('renewed', () => { if (wanted && !closed) { socket.disconnect(); open(); } });
  const offExpired = auth.on('expired', () => close());

  function start() { wanted = true; open(); }
  function stop() { wanted = false; clearTimeout(retry); retry = undefined; socket.disconnect(); }
  function close() {
    if (closed) return;
    stop(); closed = true; offRenewed(); offExpired(); socket.removeAllListeners();
  }
  function command<T>(event: string, data: object): Promise<T> {
    if (!socket.connected) return Promise.reject(new Error('Reconnecting. Try again when connected.'));
    if (pending >= MAX_PENDING) return Promise.reject(new Error('Too many pending commands. Try again.'));
    const mine = generation;
    pending++;
    const result = tail.then(async () => {
      // Never replay a queued command into a replacement connection.
      if (!socket.connected || mine !== generation) throw new Error('Connection changed. Try again.');
      const reply = await socket.timeout(8000).emitWithAck(event, data) as { data?: T; error?: string };
      if (reply.error) throw new Error(reply.error);
      return reply.data as T;
    }).finally(() => { pending--; });
    tail = result.catch(() => undefined);
    return result;
  }
  function on<T = unknown>(event: string, handler: (value: T) => void) {
    const listener = (value: T, ack?: () => void) => { try { handler(value); } finally { ack?.(); } };
    socket.on(event, listener);
    return () => { socket.off(event, listener); };
  }
  return { start, stop, close, command, on, get connected() { return socket.connected; } };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @space/mobile test -- src/shared/realtime/socket-session.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/shared/realtime
git commit -m "feat(mobile): add realtime session"
```

---

### Task 7: Server contract test for native clients

**Files:**
- Modify: `tests/integration/auth.test.ts` (append after the last test)

This proves the server already accepts the mobile approach. No server code changes.

- [ ] **Step 1: Add the test**

```ts
test('a native client keeps its session with explicit Cookie and same-origin headers', async () => {
  const user = await signup();
  const jar = new Map(user.cookie.split('; ').map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)] as const));
  const header = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const initialRefresh = jar.get('space.refresh');
  const created = await call(header(), '/workspaces', { name: 'Native workspace' });
  assert.equal(created.statusCode, 201, created.body);
  const renewed = await call(header(), '/auth/refresh', {});
  assert.equal(renewed.statusCode, 200, renewed.body);
  for (const cookie of renewed.cookies) jar.set(cookie.name, cookie.value);
  assert.notEqual(jar.get('space.refresh'), initialRefresh);
  assert.equal((await call(header(), '/me')).json().id, user.user.id);
  const client = await socket(header());
  client.disconnect();
});
```

- [ ] **Step 2: Run it**

Run (needs the same `TEST_DATABASE_URL` as CI): `pnpm test:auth`
Expected: all auth tests pass, including the new one. If it fails, stop: the spec assumption about the server is wrong and needs review before any mobile auth work continues.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/auth.test.ts
git commit -m "test(auth): cover the native client session contract"
```

---

### Task 8: Shared views, auth provider, sign-in screen

**Files:**
- Create: `apps/mobile/src/shared/ui/Centered.tsx`, `apps/mobile/src/shared/ui/Row.tsx`, `apps/mobile/src/features/auth/AuthProvider.tsx`, `apps/mobile/src/features/auth/SignInScreen.tsx`, `apps/mobile/src/features/auth/SignOutButton.tsx`
- Test: `apps/mobile/src/features/auth/SignInScreen.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SignInScreen } from './SignInScreen';

it('submits the trimmed email and the password', async () => {
  const onSubmit = jest.fn(async (_email: string, _password: string) => {});
  render(<SignInScreen onSubmit={onSubmit} />);
  fireEvent.changeText(screen.getByLabelText('Email'), ' kai@example.test ');
  fireEvent.changeText(screen.getByLabelText('Password'), 'Testing-auth-1234!');
  fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('kai@example.test', 'Testing-auth-1234!'));
});

it('shows the server error', async () => {
  const onSubmit = jest.fn(async () => { throw new Error('Invalid email or password'); });
  render(<SignInScreen onSubmit={onSubmit} />);
  fireEvent.changeText(screen.getByLabelText('Email'), 'kai@example.test');
  fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
  fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('Invalid email or password')).toBeTruthy();
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @space/mobile test -- src/features/auth`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement shared views**

`apps/mobile/src/shared/ui/Centered.tsx`:

```tsx
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

type Props = { message?: string; busy?: boolean; action?: { label: string; onPress: () => void } };

export function Centered({ message, busy, action }: Props) {
  return (
    <View style={styles.root}>
      {busy ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {action ? (
        <Pressable accessibilityRole="button" onPress={action.onPress} style={styles.button}>
          <Text style={styles.buttonText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  message: { fontSize: 16, textAlign: 'center' },
  button: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1f6feb' },
  buttonText: { color: '#ffffff', fontWeight: '600' },
});
```

`apps/mobile/src/shared/ui/Row.tsx`:

```tsx
import { Pressable, StyleSheet, Text } from 'react-native';

export function Row({ title, subtitle, onPress }: { title: string; subtitle?: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#d0d7de' },
  pressed: { opacity: 0.6 },
  title: { fontSize: 17, fontWeight: '500' },
  subtitle: { marginTop: 2, color: '#57606a' },
});
```

- [ ] **Step 4: Implement the sign-in screen**

`apps/mobile/src/features/auth/SignInScreen.tsx`:

```tsx
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { errorText } from '../../shared/api/request';

export function SignInScreen({ onSubmit }: { onSubmit: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !email.trim() || !password) return;
    setBusy(true); setError('');
    try { await onSubmit(email.trim(), password); }
    catch (reason) { setError(errorText(reason)); setBusy(false); }
  };
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={styles.title}>Sign in to Space</Text>
      <TextInput style={styles.input} accessibilityLabel="Email" placeholder="Email" value={email} onChangeText={setEmail}
        autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" />
      <TextInput style={styles.input} accessibilityLabel="Password" placeholder="Password" value={password} onChangeText={setPassword}
        secureTextEntry autoComplete="current-password" textContentType="password" onSubmitEditing={() => { void submit(); }} />
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ busy }} onPress={() => { void submit(); }} style={styles.button}>
        {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Sign in</Text>}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#d0d7de', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  error: { color: '#cf222e' },
  button: { backgroundColor: '#1f6feb', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 16 },
});
```

When busy, the button shows a spinner with no text, so the test presses it before that. The `accessibilityState` keeps the button announced while busy.

- [ ] **Step 5: Implement the auth provider and sign-out button**

`apps/mobile/src/features/auth/AuthProvider.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createApi, type Api } from '../../shared/api/request';
import { SessionClient, type SessionUser } from '../../shared/api/session';
import { serverConfig } from '../../shared/config';
import { secureStore } from '../../shared/storage/secure-store';

type Status = 'loading' | 'unavailable' | 'signed-out' | 'signed-in';
type AuthValue = {
  status: Status; user: SessionUser | null; session: SessionClient; api: Api;
  signIn(email: string, password: string): Promise<void>; signOut(): Promise<void>; retry(): void;
};
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => new SessionClient(serverConfig().baseUrl, secureStore));
  const [api] = useState(() => createApi(session));
  const [state, setState] = useState<{ status: Status; user: SessionUser | null }>({ status: 'loading', user: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => session.on('expired', () => setState({ status: 'signed-out', user: null })), [session]);
  useEffect(() => {
    let alive = true;
    session.restore().then(
      user => { if (alive) setState(user ? { status: 'signed-in', user } : { status: 'signed-out', user: null }); },
      // Keep the stored session: the server may only be unreachable.
      () => { if (alive) setState({ status: 'unavailable', user: null }); },
    );
    return () => { alive = false; };
  }, [session, attempt]);
  const signIn = useCallback(async (email: string, password: string) => {
    const user = await session.signIn(email, password);
    setState({ status: 'signed-in', user });
  }, [session]);
  const signOut = useCallback(() => session.signOut(), [session]);
  const retry = useCallback(() => { setState({ status: 'loading', user: null }); setAttempt(value => value + 1); }, []);
  const value = useMemo(() => ({ ...state, session, api, signIn, signOut, retry }), [state, session, api, signIn, signOut, retry]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
```

`apps/mobile/src/features/auth/SignOutButton.tsx`:

```tsx
import { Pressable, Text } from 'react-native';
import { useAuth } from './AuthProvider';

export function SignOutButton() {
  const { signOut } = useAuth();
  return (
    <Pressable accessibilityRole="button" hitSlop={8} onPress={() => { void signOut(); }}>
      <Text style={{ color: '#1f6feb', fontSize: 16 }}>Sign out</Text>
    </Pressable>
  );
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @space/mobile test -- src/features/auth && pnpm --filter @space/mobile typecheck`
Expected: 2 passed, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/shared/ui apps/mobile/src/features/auth
git commit -m "feat(mobile): add sign-in and auth state"
```

---

### Task 9: Realtime provider and routes

**Files:**
- Create: `apps/mobile/src/shared/realtime/RealtimeProvider.tsx`, `apps/mobile/app/sign-in.tsx`, `apps/mobile/app/(app)/_layout.tsx`
- Modify: `apps/mobile/app/_layout.tsx`
- Delete: `apps/mobile/app/index.tsx` (its place is taken by `app/(app)/index.tsx` in Task 10)

- [ ] **Step 1: Implement the provider**

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { serverConfig } from '../config';
import { Centered } from '../ui/Centered';
import { createRealtime, type Realtime, type RealtimeAuth } from './socket-session';

const RealtimeContext = createContext<Realtime | null>(null);

// The single socket owner for a signed-in session. AppState events, not timers, drive it.
export function RealtimeProvider({ session, children }: { session: RealtimeAuth; children: ReactNode }) {
  const [realtime, setRealtime] = useState<Realtime | null>(null);
  useEffect(() => {
    const next = createRealtime(serverConfig().baseUrl, session);
    setRealtime(next);
    if (AppState.currentState !== 'background') next.start();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') next.start();
      else if (state === 'background') next.stop();
    });
    return () => { subscription.remove(); next.close(); setRealtime(null); };
  }, [session]);
  if (!realtime) return <Centered busy />;
  return <RealtimeContext.Provider value={realtime}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside RealtimeProvider');
  return value;
}
```

- [ ] **Step 2: Write the routes**

`apps/mobile/app/_layout.tsx`:

```tsx
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '../src/features/auth/AuthProvider';

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}
```

`apps/mobile/app/sign-in.tsx`:

```tsx
import { Redirect } from 'expo-router';
import { useAuth } from '../src/features/auth/AuthProvider';
import { SignInScreen } from '../src/features/auth/SignInScreen';

export default function SignInRoute() {
  const auth = useAuth();
  if (auth.status === 'signed-in') return <Redirect href="/" />;
  return <SignInScreen onSubmit={auth.signIn} />;
}
```

`apps/mobile/app/(app)/_layout.tsx`:

```tsx
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../src/features/auth/AuthProvider';
import { SignOutButton } from '../../src/features/auth/SignOutButton';
import { RealtimeProvider } from '../../src/shared/realtime/RealtimeProvider';
import { Centered } from '../../src/shared/ui/Centered';

export default function SignedInLayout() {
  const auth = useAuth();
  if (auth.status === 'loading') return <Centered busy />;
  if (auth.status === 'unavailable') return <Centered message="Space is not reachable right now." action={{ label: 'Try again', onPress: auth.retry }} />;
  if (auth.status === 'signed-out') return <Redirect href="/sign-in" />;
  return (
    <RealtimeProvider session={auth.session}>
      <Stack screenOptions={{ headerRight: () => <SignOutButton /> }} />
    </RealtimeProvider>
  );
}
```

Run: `git rm apps/mobile/app/index.tsx`

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @space/mobile typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/shared/realtime/RealtimeProvider.tsx apps/mobile/app
git commit -m "feat(mobile): add auth gate and realtime owner"
```

---

### Task 10: Workspace and channel lists

**Files:**
- Create: `apps/mobile/src/features/workspaces/WorkspaceList.tsx`, `apps/mobile/src/features/channels/channels.ts`, `apps/mobile/src/features/channels/ChannelList.tsx`, `apps/mobile/app/(app)/index.tsx`, `apps/mobile/app/(app)/workspaces/[workspaceId].tsx`
- Test: `apps/mobile/src/features/channels/channels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import type { ChannelSummary } from '@space/contracts';
import { visibleChannels } from './channels';

const channel = (patch: Partial<ChannelSummary>): ChannelSummary => ({
  id: patch.name ?? 'x', workspace_id: 'w', name: 'x', private: false, joined: true, topic: '', description: '',
  archived_at: null, created_by: null, created_at: '2026-11-11T00:00:00Z', ...patch,
});

it('lists joined, active, non-direct channels by name', () => {
  const result = visibleChannels([
    channel({ name: 'zeta' }), channel({ name: 'alpha' }), channel({ name: 'left', joined: false }),
    channel({ name: 'old', archived_at: '2026-01-01T00:00:00Z' }), channel({ name: 'dm', kind: 'direct' }),
  ]);
  expect(result.map(item => item.name)).toEqual(['alpha', 'zeta']);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @space/mobile test -- src/features/channels`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`apps/mobile/src/features/channels/channels.ts`:

```ts
import type { ChannelSummary } from '@space/contracts';

export function visibleChannels(items: ChannelSummary[]) {
  return items
    .filter(channel => channel.joined && !channel.archived_at && channel.kind !== 'direct')
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

`apps/mobile/src/features/channels/ChannelList.tsx`:

```tsx
import type { ChannelSummary } from '@space/contracts';
import { router } from 'expo-router';
import { FlatList } from 'react-native';
import { useLoad } from '../../shared/api/useLoad';
import { Centered } from '../../shared/ui/Centered';
import { Row } from '../../shared/ui/Row';
import { useAuth } from '../auth/AuthProvider';
import { visibleChannels } from './channels';

export function ChannelList({ workspaceId }: { workspaceId: string }) {
  const { api } = useAuth();
  const state = useLoad(() => api.listAll<ChannelSummary>(`/workspaces/${encodeURIComponent(workspaceId)}/channels`), [api, workspaceId]);
  const channels = state.data ? visibleChannels(state.data) : undefined;
  if (!channels) return state.error ? <Centered message={state.error} action={{ label: 'Try again', onPress: state.reload }} /> : <Centered busy />;
  if (!channels.length) return <Centered message="You have not joined any channels in this workspace yet." />;
  return (
    <FlatList data={channels} keyExtractor={item => item.id} onRefresh={state.reload} refreshing={state.loading}
      renderItem={({ item }) => (
        <Row title={`# ${item.name}`} subtitle={item.topic || undefined}
          onPress={() => router.push({ pathname: '/channels/[channelId]', params: { channelId: item.id, name: item.name } })} />
      )} />
  );
}
```

`apps/mobile/src/features/workspaces/WorkspaceList.tsx`:

```tsx
import { Redirect, router } from 'expo-router';
import { FlatList } from 'react-native';
import { useLoad } from '../../shared/api/useLoad';
import { Centered } from '../../shared/ui/Centered';
import { Row } from '../../shared/ui/Row';
import { useAuth } from '../auth/AuthProvider';

type Workspace = { id: string; name: string };
const open = (workspace: Workspace) => ({ pathname: '/workspaces/[workspaceId]' as const, params: { workspaceId: workspace.id, name: workspace.name } });

export function WorkspaceList() {
  const { api } = useAuth();
  const state = useLoad(() => api.listAll<Workspace>('/workspaces'), [api]);
  const items = state.data;
  if (!items) return state.error ? <Centered message={state.error} action={{ label: 'Try again', onPress: state.reload }} /> : <Centered busy />;
  if (!items.length) return <Centered message="You are not in a workspace yet. Ask an admin to invite you." />;
  if (items.length === 1) return <Redirect href={open(items[0]!)} />;
  return (
    <FlatList data={items} keyExtractor={item => item.id} onRefresh={state.reload} refreshing={state.loading}
      renderItem={({ item }) => <Row title={item.name} onPress={() => router.push(open(item))} />} />
  );
}
```

`apps/mobile/app/(app)/index.tsx`:

```tsx
import { Stack } from 'expo-router';
import { WorkspaceList } from '../../src/features/workspaces/WorkspaceList';

export default function WorkspacesRoute() {
  return <><Stack.Screen options={{ title: 'Workspaces' }} /><WorkspaceList /></>;
}
```

`apps/mobile/app/(app)/workspaces/[workspaceId].tsx`:

```tsx
import { Stack, useLocalSearchParams } from 'expo-router';
import { ChannelList } from '../../../src/features/channels/ChannelList';

export default function ChannelsRoute() {
  const { workspaceId, name } = useLocalSearchParams<{ workspaceId: string; name?: string }>();
  return <><Stack.Screen options={{ title: name ?? 'Channels' }} /><ChannelList workspaceId={workspaceId} /></>;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @space/mobile test -- src/features/channels && pnpm --filter @space/mobile typecheck`
Expected: 1 passed, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/workspaces apps/mobile/src/features/channels apps/mobile/app
git commit -m "feat(mobile): list workspaces and channels"
```

---

### Task 11: History window copy

**Files:**
- Create: `apps/mobile/src/features/chat/history-window.ts`, `apps/mobile/src/features/chat/history-window.test.ts` (copied from web)

- [ ] **Step 1: Copy the file and its tests**

```bash
cp apps/web/src/features/chat/history-window.ts apps/mobile/src/features/chat/history-window.ts
cp apps/web/src/features/chat/history-window.test.ts apps/mobile/src/features/chat/history-window.test.ts
```

- [ ] **Step 2: Adapt the test to Jest**

In `apps/mobile/src/features/chat/history-window.test.ts`, delete line 1 (`import { expect, it } from 'vitest';`) and change `'./history-window.js'` to `'./history-window'`.

At the top of `apps/mobile/src/features/chat/history-window.ts`, add:

```ts
// Copied from apps/web/src/features/chat/history-window.ts. Keep both in sync until it moves to a shared package.
```

- [ ] **Step 3: Run the tests**

Run: `pnpm --filter @space/mobile test -- src/features/chat/history-window.test.ts`
Expected: same number of passing tests as `pnpm --filter @space/web exec vitest run src/features/chat/history-window.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/features/chat/history-window.ts apps/mobile/src/features/chat/history-window.test.ts
git commit -m "feat(mobile): reuse the web message history window"
```

---

### Task 12: Outbox

**Files:**
- Create: `apps/mobile/src/features/chat/outbox.ts`
- Test: `apps/mobile/src/features/chat/outbox.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import type { ChatMessage } from '@space/contracts';
import { failed, reconcile, sending, type Outgoing } from './outbox';

const saved = (clientId: string, author = 'u1'): ChatMessage => ({
  id: `m-${clientId}`, client_message_id: clientId, channel_id: 'c', thread_id: 't', task_id: null,
  text: 'hi', created_at: '2026-11-11T00:00:00Z', author: { kind: 'human', id: author, name: 'Kai' },
});

it('adds pending messages and retries one in place', () => {
  let list = sending(sending([], { id: 'a', text: 'one' }), { id: 'b', text: 'two' });
  list = failed(list, 'a', 'Connection changed. Try again.');
  expect(list.map(entry => [entry.id, entry.status])).toEqual([['a', 'failed'], ['b', 'sending']]);
  list = sending(list, list[0]!);
  expect(list).toEqual([{ id: 'a', text: 'one', status: 'sending' }, { id: 'b', text: 'two', status: 'sending' }]);
});

it('removes entries the viewer\'s saved message confirms', () => {
  const list: Outgoing[] = [{ id: 'a', text: 'one', status: 'failed', error: 'x' }, { id: 'b', text: 'two', status: 'sending' }];
  expect(reconcile(list, [saved('a')], 'u1').map(entry => entry.id)).toEqual(['b']);
});

it('ignores another person\'s message with the same client id', () => {
  const list: Outgoing[] = [{ id: 'a', text: 'one', status: 'sending' }];
  expect(reconcile(list, [saved('a', 'u2')], 'u1')).toBe(list);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @space/mobile test -- src/features/chat/outbox.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { ChatMessage } from '@space/contracts';

export type Outgoing = { id: string; text: string; status: 'sending' | 'failed'; error?: string };

// A retry keeps its client_message_id, so the server deduplicates a send whose ack was lost.
export function sending(list: Outgoing[], entry: Pick<Outgoing, 'id' | 'text'>): Outgoing[] {
  const next: Outgoing = { id: entry.id, text: entry.text, status: 'sending' };
  return list.some(item => item.id === entry.id) ? list.map(item => item.id === entry.id ? next : item) : [...list, next];
}

export function failed(list: Outgoing[], id: string, error: string): Outgoing[] {
  return list.map(item => item.id === id ? { ...item, status: 'failed', error } : item);
}

export function reconcile(list: Outgoing[], incoming: ChatMessage[], viewerId: string): Outgoing[] {
  const confirmed = new Set(incoming
    .filter(message => message.author.kind === 'human' && message.author.id === viewerId && message.client_message_id)
    .map(message => message.client_message_id));
  return confirmed.size ? list.filter(item => !confirmed.has(item.id)) : list;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @space/mobile test -- src/features/chat/outbox.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/chat/outbox.ts apps/mobile/src/features/chat/outbox.test.ts
git commit -m "feat(mobile): track pending sends"
```

---

### Task 13: Conversation

**Files:**
- Create: `apps/mobile/src/features/chat/useChannel.ts`, `apps/mobile/src/features/chat/ChannelScreen.tsx`, `apps/mobile/app/(app)/channels/[channelId].tsx`

The hook loads the latest page, then sends `channel.subscribe` with that page's `event_cursor`. Each `chat.events` batch moves the cursor. Each `connect` resubscribes from the cursor, so the server replays what was missed in the background. The pure parts it uses are tested in Tasks 6, 11 and 12; the hook itself is covered by the manual check in Task 14.

- [ ] **Step 1: Implement `useChannel.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import type { ChatEvent, ChatMessage, MessagePage } from '@space/contracts';
import { ApiError, errorText } from '../../shared/api/request';
import { useRealtime } from '../../shared/realtime/RealtimeProvider';
import { useAuth } from '../auth/AuthProvider';
import { appendLive, mergePage } from './history-window';
import { failed, reconcile, sending, type Outgoing } from './outbox';

export const MAX_TEXT = 16_000; // Server limit in packages/contracts/chat.ts.
export const MAX_PENDING = 50;
type Batch = { channel_id: string; events: ChatEvent[]; cursor: string };
const NO_ACCESS = new Set(['forbidden', 'not_found', 'invalid_id']);

export function useChannel(channelId: string) {
  const { api, user } = useAuth();
  const realtime = useRealtime();
  const viewerId = user?.id ?? '';
  const path = `/channels/${encodeURIComponent(channelId)}/messages`;
  const [page, setPageState] = useState<MessagePage | null>(null);
  const [outgoing, setOutgoingState] = useState<Outgoing[]>([]);
  const [error, setError] = useState('');
  const [noAccess, setNoAccess] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const pageRef = useRef<MessagePage | null>(null);
  const outgoingRef = useRef<Outgoing[]>([]);
  const atLatest = useRef(true);
  const olderBusy = useRef(false);
  const alive = useRef(true);
  const reload = useRef<() => Promise<void>>(async () => {});
  const setPage = useCallback((next: MessagePage | null) => { pageRef.current = next; setPageState(next); }, []);
  const setOutgoing = useCallback((next: Outgoing[]) => { outgoingRef.current = next; setOutgoingState(next); }, []);

  useEffect(() => {
    alive.current = true;
    setPage(null); setOutgoing([]); setError(''); setNoAccess(false);
    let epoch = 0;
    let cursor: string | null = null;
    const subscribe = async () => {
      if (!cursor || !realtime.connected) return;
      try {
        await realtime.command('channel.subscribe', { channel_id: channelId, after: cursor });
        if (alive.current) setError('');
      } catch (reason) {
        if (!alive.current) return;
        const code = reason instanceof Error ? reason.message : '';
        if (NO_ACCESS.has(code)) setNoAccess(true);
        else if (code === 'invalid_cursor') void loadLatest();
        // Other failures retry on the next connect.
      }
    };
    const loadLatest = async () => {
      const mine = ++epoch;
      try {
        const result = await api.request<MessagePage>(path);
        if (!alive.current || mine !== epoch) return;
        setPage(mergePage(pageRef.current, result, 'latest'));
        cursor = result.event_cursor;
        setError('');
        await subscribe();
      } catch (reason) {
        if (!alive.current || mine !== epoch) return;
        if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) setNoAccess(true);
        else setError(errorText(reason));
      }
    };
    reload.current = loadLatest;
    const offEvents = realtime.on<Batch>('chat.events', batch => {
      if (!alive.current || batch.channel_id !== channelId || !pageRef.current) return;
      const incoming = batch.events.flatMap(event => event.type === 'message.created' || event.type === 'message.updated'
        ? [{ ...event.payload, sequence: event.payload.sequence ?? event.sequence }] : []);
      cursor = batch.cursor;
      if (!incoming.length) return;
      setPage(appendLive(pageRef.current, incoming, atLatest.current, true));
      setOutgoing(reconcile(outgoingRef.current, incoming, viewerId));
    });
    const offConnect = realtime.on('connect', () => { void subscribe(); });
    void loadLatest();
    return () => {
      alive.current = false; epoch++;
      offEvents(); offConnect();
      if (realtime.connected) void realtime.command('channel.unsubscribe', { channel_id: channelId }).catch(() => undefined);
    };
  }, [api, channelId, path, realtime, setOutgoing, setPage, viewerId]);

  const loadOlder = useCallback(async () => {
    const current = pageRef.current;
    if (olderBusy.current || !current?.has_older || !current.older_cursor) return;
    olderBusy.current = true; setLoadingOlder(true);
    try {
      const result = await api.request<MessagePage>(`${path}?before=${encodeURIComponent(current.older_cursor)}`);
      if (alive.current && pageRef.current) setPage(mergePage(pageRef.current, result, 'older'));
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      olderBusy.current = false;
      if (alive.current) setLoadingOlder(false);
    }
  }, [api, path, setPage]);

  const setAtLatest = useCallback((value: boolean) => {
    if (atLatest.current === value) return;
    atLatest.current = value;
    // Live messages stop extending a window the reader scrolled away from. Rejoin the latest page.
    if (value && pageRef.current?.has_newer) void reload.current();
  }, []);

  const deliver = useCallback(async (entry: Pick<Outgoing, 'id' | 'text'>) => {
    setOutgoing(sending(outgoingRef.current, entry));
    try {
      const saved = await realtime.command<ChatMessage>('message.send', { channel_id: channelId, client_message_id: entry.id, text: entry.text });
      if (!alive.current) return;
      if (pageRef.current) setPage(appendLive(pageRef.current, [saved], true, true));
      setOutgoing(reconcile(outgoingRef.current, [saved], viewerId));
    } catch (reason) {
      if (alive.current) setOutgoing(failed(outgoingRef.current, entry.id, errorText(reason)));
    }
  }, [channelId, realtime, setOutgoing, setPage, viewerId]);

  const send = useCallback((text: string) => {
    const value = text.trim();
    if (!value || value.length > MAX_TEXT || outgoingRef.current.length >= MAX_PENDING) return false;
    void deliver({ id: Crypto.randomUUID(), text: value });
    return true;
  }, [deliver]);

  const retry = useCallback((id: string) => {
    const entry = outgoingRef.current.find(item => item.id === id);
    if (entry?.status === 'failed') void deliver(entry);
  }, [deliver]);

  return { page, outgoing, error, noAccess, loadingOlder, loadOlder, setAtLatest, send, retry };
}
```

- [ ] **Step 2: Implement `ChannelScreen.tsx`**

```tsx
import { useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { ChatMessage } from '@space/contracts';
import { Centered } from '../../shared/ui/Centered';
import type { Outgoing } from './outbox';
import { MAX_PENDING, MAX_TEXT, useChannel } from './useChannel';

type Row = { key: string; message: ChatMessage } | { key: string; outgoing: Outgoing };

export function ChannelScreen({ channelId }: { channelId: string }) {
  const chat = useChannel(channelId);
  const [draft, setDraft] = useState('');
  if (chat.noAccess) return <Centered message="You can't open this channel." action={{ label: 'Back to channels', onPress: () => router.back() }} />;
  // The list is inverted: index 0 is the newest row at the bottom.
  const rows: Row[] = [
    ...[...chat.outgoing].reverse().map(outgoing => ({ key: `out:${outgoing.id}`, outgoing })),
    ...[...(chat.page?.messages ?? [])].reverse().map(message => ({ key: message.id, message })),
  ];
  const submit = () => { if (chat.send(draft)) setDraft(''); };
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}>
      {chat.error ? <Text accessibilityRole="alert" style={styles.banner}>{chat.error}</Text> : null}
      {!chat.page ? <Centered busy={!chat.error} /> : (
        <FlatList inverted data={rows} keyExtractor={row => row.key} contentContainerStyle={styles.list}
          renderItem={({ item }) => 'message' in item ? <MessageRow message={item.message} /> : <OutgoingRow entry={item.outgoing} onRetry={chat.retry} />}
          onEndReached={() => { void chat.loadOlder(); }} onEndReachedThreshold={0.5}
          onScroll={event => chat.setAtLatest(event.nativeEvent.contentOffset.y < 48)} scrollEventThrottle={100}
          ListFooterComponent={chat.loadingOlder ? <ActivityIndicator style={styles.older} /> : null} />
      )}
      <View style={styles.composer}>
        <TextInput style={styles.input} value={draft} onChangeText={setDraft} placeholder="Message" accessibilityLabel="Message" multiline maxLength={MAX_TEXT} />
        <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={!draft.trim() || chat.outgoing.length >= MAX_PENDING} onPress={submit} style={styles.send}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const body = message.deleted_at ? 'This message was deleted.' : message.text || (message.attachments?.length ? 'Shared a file.' : '');
  return (
    <View style={styles.row}>
      <Text style={styles.meta}>{message.author.name} · {time}</Text>
      <Text style={message.deleted_at ? styles.deleted : styles.text}>{body}</Text>
    </View>
  );
}

function OutgoingRow({ entry, onRetry }: { entry: Outgoing; onRetry: (id: string) => void }) {
  const isFailed = entry.status === 'failed';
  return (
    <Pressable disabled={!isFailed} onPress={() => onRetry(entry.id)} accessibilityRole={isFailed ? 'button' : undefined}
      accessibilityHint={isFailed ? 'Sends the message again' : undefined} style={styles.row}>
      <Text style={styles.text}>{entry.text}</Text>
      <Text style={isFailed ? styles.failed : styles.meta}>{isFailed ? `${entry.error ?? 'Not sent.'} Tap to retry.` : 'Sending…'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: { padding: 10, backgroundColor: '#fff8c5', color: '#4d2d00' },
  list: { paddingVertical: 8 },
  older: { marginVertical: 12 },
  row: { paddingHorizontal: 16, paddingVertical: 6 },
  meta: { fontSize: 12, color: '#57606a' },
  text: { fontSize: 16 },
  deleted: { fontSize: 16, fontStyle: 'italic', color: '#57606a' },
  failed: { fontSize: 12, color: '#cf222e' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#d0d7de' },
  input: { flex: 1, maxHeight: 140, borderWidth: 1, borderColor: '#d0d7de', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  send: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1f6feb' },
  sendText: { color: '#ffffff', fontWeight: '600' },
});
```

- [ ] **Step 3: Add the route**

`apps/mobile/app/(app)/channels/[channelId].tsx`:

```tsx
import { Stack, useLocalSearchParams } from 'expo-router';
import { ChannelScreen } from '../../../src/features/chat/ChannelScreen';

export default function ChannelRoute() {
  const { channelId, name } = useLocalSearchParams<{ channelId: string; name?: string }>();
  return <><Stack.Screen options={{ title: name ? `# ${name}` : 'Channel' }} /><ChannelScreen channelId={channelId} /></>;
}
```

- [ ] **Step 4: Run all mobile tests and typecheck**

Run: `pnpm --filter @space/mobile test && pnpm --filter @space/mobile typecheck`
Expected: all suites pass, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/chat apps/mobile/app
git commit -m "feat(mobile): read and send channel messages"
```

---

### Task 14: Full verification and manual check

- [ ] **Step 1: Monorepo checks**

Run from the repo root:

```bash
pnpm exec turbo run build typecheck --concurrency=2
pnpm --filter @space/mobile test
pnpm test:auth
```

Expected: all exit 0. Turbo lists `@space/mobile#typecheck`.

- [ ] **Step 2: Local stack and config**

1. Start the local stack as described in `README.md` (server on port 3000 unless `PORT` is set).
2. iOS simulator: create `apps/mobile/.env.local` with `EXPO_PUBLIC_SPACE_URL` set to the server origin the simulator reaches, for example `http://127.0.0.1:3000`.
3. Android emulator: the host is `10.0.2.2`. Use `EXPO_PUBLIC_SPACE_URL=http://10.0.2.2:3000` and add `http://10.0.2.2:3000` to the server's `AUTH_TRUSTED_ORIGINS`, then restart the server.
4. The value of `EXPO_PUBLIC_SPACE_URL` must be the server's `BETTER_AUTH_URL` origin or be listed in `AUTH_TRUSTED_ORIGINS`. Otherwise writes return `403 untrusted_origin`.

- [ ] **Step 3: Manual check on iOS, then Android**

Run `pnpm mobile`, open in Expo Go, and confirm each item:

1. A wrong password shows the server error. The right one opens the workspace or channel list.
2. Force-quit and reopen the app: it stays signed in.
3. Open a channel. History loads. Scrolling up loads older messages.
4. Send from mobile: it shows "Sending…", then appears in the web app.
5. Send from web: it appears on mobile within a second.
6. Background the app. Send two messages from web. Foreground the app: both appear, once each.
7. Turn on airplane mode, send: the row shows the error and "Tap to retry". Turn airplane mode off, tap: it sends once.
8. Wait more than 15 minutes with the app open, then send: it works (access renewal).
9. Sign out. In the web app's network tools, or with `curl`, confirm the old cookies no longer read `/v1/me`.

- [ ] **Step 4: Commit any fixes**

Commit each fix with its own test where one is possible, using `fix(mobile): ...` messages.

---

## Self-review notes

- Spec coverage: config (Task 2), cookie jar and session (3–5), realtime and AppState (6, 9), server contract (7), sign-in and sign-out (8), workspace and channel lists (10), history window, outbox and conversation (11–13), manual check (14).
- Known limits kept from the spec: plain text only, no threads, at most 1,000 workspaces or channels per list, at most 50 pending sends.
- Risk to watch in Task 1: Metro with pnpm 8.10.3. The plan stops instead of changing the monorepo's install layout.
