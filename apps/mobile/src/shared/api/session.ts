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
