// Credentials stay in HttpOnly cookies. The tab keeps only the session ID and access deadline.
let activeId: string | undefined;
let expires = 0;
let deadline: ReturnType<typeof setTimeout> | undefined;
let pending: { id?: string; promise: Promise<boolean> } | undefined;

function track(id?: string, exp = 0) {
  clearTimeout(deadline);
  activeId = id;
  expires = exp;
  if (!id || !exp) return;
  // A one-shot deadline for this JWT. A sleeping tab renews on its next request.
  const remaining = exp - Date.now();
  deadline = setTimeout(() => {
    if (document.hidden) return;
    void renewSession(id).then(ok => {
      if (!ok && activeId === id) window.dispatchEvent(new Event('space:session-expired'));
    }).catch(() => { /* The next request or focus can retry after a connection failure. */ });
  }, Math.max(1000, remaining > 30_000 ? remaining - 30_000 : remaining));
}

function expiry(response: Response) {
  const expiration = Number(response.headers.get('x-space-access-expires')) * 1000;
  if (!expiration) return 0;
  const serverTime = Date.parse(response.headers.get('date') ?? '');
  return Number.isFinite(serverTime) ? Date.now() + expiration - serverTime : expiration;
}

function renewSession(id?: string): Promise<boolean> {
  if (pending && pending.id === id) return pending.promise;
  const before = activeId;
  const promise = (async () => {
    const response = await fetch('/v1/auth/refresh', {
      method: 'POST', credentials: 'same-origin', headers: {
        'content-type': 'application/json', ...(id ? { 'x-space-session-id': id } : {}),
      }, body: '{}',
    });
    if (response.status === 401) return false;
    if (!response.ok) throw new Error('Could not renew your session. Please try again.');
    const { sessionId } = await response.json();
    if (before !== activeId || (id && id !== sessionId)) return false;
    track(sessionId, expiry(response));
    window.dispatchEvent(new Event('space:access-renewed'));
    return true;
  })().finally(() => { if (pending?.promise === promise) pending = undefined; });
  pending = { id, promise };
  return promise;
}

export function recoverSocketSession() {
  return activeId ? renewSession(activeId) : Promise.resolve(false);
}

export async function sessionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const id = activeId;
  if (id && expires && Date.now() >= expires - 5000) {
    if (!await renewSession(id)) return new Response('{"error":"unauthorized"}', { status: 401 });
  }
  const response = await fetch(input, init);
  // The API rejects an unauthenticated request before entering its route handler.
  if (response.status === 401 && id && id === activeId && response.headers.get('x-space-auth-required') && await renewSession(id)) return fetch(input, init);
  return response;
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(input instanceof Request ? input.url : input.toString(), window.location.origin).pathname;
  if (path.endsWith('/sign-out')) {
    const response = await fetch(input, init);
    if (response.ok) track();
    return response;
  }
  if (!path.endsWith('/get-session')) {
    if (path.includes('/sign-in/') || path.includes('/sign-up/')) return fetch(input, init);
    return sessionFetch(input, init);
  }
  let response = await fetch(input, init);
  if (!response.ok) return response;
  if (response.headers.get('x-space-refresh-available') && !response.headers.get('x-space-session-id')) {
    if (await renewSession()) response = await fetch(input, init);
  }
  if (response.ok) track(response.headers.get('x-space-session-id') ?? undefined, expiry(response));
  return response;
}
