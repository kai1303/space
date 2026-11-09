import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Credentials, Registration } from './storage.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export interface OAuthOptions {
  fetch?: typeof fetch;
  keys?: JWTVerifyGetKey;
  announce?: (url: string) => Promise<void>;
  signal?: AbortSignal;
}

function tokenFields(raw: unknown) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid OAuth token response.');
  const value = raw as Record<string, unknown>;
  if (typeof value.access_token !== 'string' || !value.access_token || typeof value.refresh_token !== 'string' || !value.refresh_token || value.token_type !== 'Bearer' || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || typeof value.scope !== 'string') throw new Error('Incomplete OAuth token response.');
  const granted = value.scope.split(/\s+/);
  if (!granted.includes('chatgpt.tokens.use.direct') || !granted.includes('resource.invoke')) throw new Error('ChatGPT plan permission was not granted. Run with --login to authorize plan use.');
  return { access_token: value.access_token, refresh_token: value.refresh_token, scopes: granted, expires_at: Date.now() + value.expires_in * 1000 };
}

export async function validateTokens(raw: unknown, clientId: string, options: { nonce?: string; subject?: string; keys?: JWTVerifyGetKey } = {}): Promise<Credentials> {
  const fields = tokenFields(raw);
  const idToken = (raw as Record<string, unknown>).id_token;
  if (!clientId || clientId === 'dynamic_agent_client' || typeof idToken !== 'string') throw new Error('OAuth registration is incomplete.');
  const { payload } = await jwtVerify(idToken, options.keys ?? keys, { issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['exp', 'sub'] });
  if (options.nonce !== undefined && payload.nonce !== options.nonce) throw new Error('OAuth nonce does not match.');
  if (typeof payload.sub !== 'string' || !payload.sub || (options.subject !== undefined && payload.sub !== options.subject)) throw new Error('OAuth account identity does not match.');
  return { ...fields, id_token: idToken, client_id: clientId, subject: payload.sub, issuer };
}

async function exchange(form: URLSearchParams, options: OAuthOptions): Promise<unknown> {
  const response = await (options.fetch ?? fetch)(tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('ChatGPT authorization could not be renewed. Run with --login to authorize again.');
  return response.json();
}

export async function authorize(hostId: string, registration?: Registration, options: OAuthOptions = {}): Promise<Credentials> {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  let settle!: (params: URLSearchParams) => void;
  let fail!: (error: Error) => void;
  const callback = new Promise<URLSearchParams>((resolve, reject) => { settle = resolve; fail = reject; });
  // Attach immediately: the browser callback can arrive while announce is still awaiting.
  void callback.catch(() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (url.pathname !== '/auth/callback' || request.method !== 'GET') { response.writeHead(404).end('Not found'); return; }
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400).end('Sign-in could not be validated. Return to your terminal.');
      fail(new Error('OAuth state does not match.'));
      return;
    }
    response.end('Return to Space to finish connecting.');
    settle(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the local OAuth callback.');
  const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
  const url = new URL(`${issuer}/api/accounts/authorize`);
  const params: Record<string, string> = {
    client_id: registration?.client_id ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
    response_type: 'code', redirect_uri: redirect, scope: scopes, resource, state, nonce,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
  if (!registration) params.agent_name_hint = 'space_connector';
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const timeout = setTimeout(() => fail(new Error('ChatGPT sign-in timed out. Run with --login to try again.')), 5 * 60_000);
  const abort = () => fail(new Error('ChatGPT sign-in cancelled.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    await (options.announce ?? (async value => { console.log(`Continue with ChatGPT — open this URL in your browser:\n${value}`); }))(url.toString());
    const result = await callback;
    if (result.has('error')) throw new Error('ChatGPT sign-in was declined. Run with --login when you are ready.');
    const clientId = result.get('client_id') ?? registration?.client_id;
    if (!clientId || clientId === 'dynamic_agent_client' || (registration && clientId !== registration.client_id)) throw new Error('OAuth callback client does not match the registration.');
    const code = result.get('code');
    if (!code) throw new Error('OAuth callback did not contain an authorization code.');
    const raw = await exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource }), options);
    return await validateTokens(raw, clientId, { nonce, subject: registration?.subject, keys: options.keys });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export async function refreshCredentials(current: Credentials, options: OAuthOptions = {}): Promise<Credentials> {
  const raw = await exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: current.client_id, refresh_token: current.refresh_token, resource }), options);
  const value = raw as Record<string, unknown>;
  // OAuth permits omitting unchanged fields on refresh; rotate any replacements together.
  const response = { ...value, refresh_token: value.refresh_token ?? current.refresh_token, scope: value.scope ?? current.scopes.join(' ') };
  if (value.id_token !== undefined) return validateTokens(response, current.client_id, { subject: current.subject, keys: options.keys });
  return { ...current, ...tokenFields(response) };
}

export async function revokeCredentials(current: Credentials, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const discovery = await request(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!discovery.ok) return false;
    const metadata = await discovery.json() as { revocation_endpoint?: string };
    const endpoint = new URL(metadata.revocation_endpoint ?? '');
    if (endpoint.origin !== issuer) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await request(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: current.refresh_token, token_type_hint: 'refresh_token', client_id: current.client_id }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (response.status === 200) return true;
        if (response.status < 500) return false;
      } catch { /* Retry transient failure before clearing local tokens. */ }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
  } catch { /* Local logout still clears tokens if discovery is unavailable. */ }
  return false;
}
