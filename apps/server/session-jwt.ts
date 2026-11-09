import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { GenericEndpointContext } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { setRequestCookie } from 'better-auth/cookies';
import { makeSignature } from 'better-auth/crypto';
import { errors, jwtVerify, SignJWT } from 'jose';
import type { database } from '@space/postgres/database';

const accessSeconds = 15 * 60;
const audience = 'space:browser-session';
const type = 'space-session+jwt';
const refreshPath = '/v1/auth';
const hash = (token: string) => createHash('sha256').update(token).digest();
type StoredSession = { id: string; token: string; expires_at: Date; persistent: boolean };

export function browserSessions(pool: Parameters<typeof database>[0], secret: string, issuer: string, origins: Set<string>) {
  const key = new Uint8Array(hkdfSync('sha256', secret, '', audience, 32));
  const rotationKey = new Uint8Array(hkdfSync('sha256', secret, issuer, 'space:refresh-rotation', 32));
  const refreshName = issuer.startsWith('https:') ? '__Secure-space.refresh' : 'space.refresh';

  async function issue(ctx: GenericEndpointContext, session: StoredSession, refresh: string) {
    const now = Math.floor(Date.now() / 1000);
    const end = Math.floor(session.expires_at.getTime() / 1000);
    const exp = Math.min(end, now + accessSeconds);
    const jwt = await new SignJWT().setProtectedHeader({ alg: 'HS256', typ: type })
      .setIssuer(issuer).setAudience(audience).setJti(session.token).setIssuedAt(now).setExpirationTime(exp).sign(key);
    const { name, attributes } = ctx.context.authCookies.sessionToken;
    ctx.setCookie(name, jwt, { ...attributes, maxAge: session.persistent ? exp - now : undefined });
    ctx.setCookie(refreshName, refresh, { ...attributes, path: refreshPath, maxAge: session.persistent ? end - now : undefined });
    ctx.setHeader('x-space-access-expires', String(exp));
  }

  function refreshCookie(ctx: GenericEndpointContext) {
    const token = ctx.getCookie(refreshName);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }

  // The second statement gets a fresh snapshot after a concurrent conditional update.
  // Only the immediate predecessor can recover the same successor, for ten seconds.
  async function findRefresh(digest: Buffer, expected: string | null, allowCurrent: boolean) {
    const { rows } = await pool.query<StoredSession>(`SELECT s.id, s.token, s.expires_at, r.persistent
      FROM auth_session_refresh r JOIN auth_sessions s ON s.id=r.session_id
      WHERE (($3 AND r.token_hash=$1) OR (r.previous_hash=$1 AND r.rotated_at > now()-interval '10 seconds'))
        AND s.expires_at > now() AND ($2::text IS NULL OR s.id::text=$2)`, [digest, expected, allowCurrent]);
    return rows[0];
  }

  const renew = createAuthEndpoint('/refresh', { method: 'POST', requireHeaders: true }, async ctx => {
    if (!origins.has(ctx.headers.get('origin') ?? '')) throw new APIError('FORBIDDEN');
    const token = refreshCookie(ctx);
    if (!token) throw new APIError('UNAUTHORIZED');
    const expected = ctx.headers.get('x-space-session-id');
    const digest = hash(token);
    const next = createHmac('sha256', rotationKey).update(token).digest('base64url');
    const { rows } = await pool.query<StoredSession>(`UPDATE auth_session_refresh r
      SET previous_hash=r.token_hash, token_hash=$2, rotated_at=now()
      FROM auth_sessions s WHERE r.token_hash=$1 AND s.id=r.session_id AND s.expires_at > now()
        AND ($3::text IS NULL OR s.id::text=$3)
      RETURNING s.id, s.token, s.expires_at, r.persistent`, [digest, hash(next), expected]);
    const session = rows[0] ?? await findRefresh(digest, expected, false);
    if (!session) throw new APIError('UNAUTHORIZED');
    await issue(ctx, session, next);
    return ctx.json({ sessionId: session.id });
  });

  return {
    plugin: { id: 'space-browser-session', endpoints: { renewBrowserSession: renew } },
    hooks: {
      before: createAuthMiddleware(async ctx => {
        const name = ctx.context.authCookies.sessionToken.name;
        const cookie = ctx.getCookie(name);
        let sessionToken: string | undefined;
        if (cookie?.split('.').length === 3) {
          try {
            const { payload } = await jwtVerify(cookie, key, {
              algorithms: ['HS256'], issuer, audience, typ: type, requiredClaims: ['exp', 'iat', 'jti'],
            });
            sessionToken = payload.jti;
            if (ctx.path === '/get-session') ctx.setHeader('x-space-access-expires', String(payload.exp));
          } catch (error) {
            if (!(error instanceof errors.JOSEError)) throw error;
          }
        }
        if (ctx.path === '/sign-out' && !sessionToken) {
          const refresh = refreshCookie(ctx);
          if (refresh) sessionToken = (await findRefresh(hash(refresh), null, true))?.token;
        }
        // Older two-part Better Auth cookies retain their original expiry.
        if (!sessionToken && cookie?.split('.').length !== 3) return;
        const headers = new Headers(ctx.headers ?? ctx.request?.headers);
        setRequestCookie(headers, name, sessionToken ? `${sessionToken}.${await makeSignature(sessionToken, secret)}` : '');
        return { context: { headers } };
      }),
      after: createAuthMiddleware(async ctx => {
        const { name, attributes } = ctx.context.authCookies.sessionToken;
        if (ctx.path === '/sign-out') {
          ctx.setCookie(refreshName, '', { ...attributes, path: refreshPath, maxAge: 0 });
          return;
        }
        if (ctx.path === '/get-session' && refreshCookie(ctx)) {
          if (ctx.context.returned && ctx.context.session) ctx.setHeader('x-space-session-id', ctx.context.session.session.id);
          ctx.setHeader('x-space-refresh-available', '1');
        }
        const session = ctx.context.newSession?.session;
        const headers = ctx.context.responseHeaders;
        if (!session || !headers) return;
        const cookies = headers.getSetCookie();
        const original = cookies.find(cookie => cookie.startsWith(`${name}=${session.token}.`));
        if (!original) return;
        const persistent = /;\s*max-age=/i.test(original);
        const refresh = randomBytes(32).toString('base64url');
        await pool.query('INSERT INTO auth_session_refresh(session_id,token_hash,persistent) VALUES ($1,$2,$3)',
          [session.id, hash(refresh), persistent]);
        headers.delete('set-cookie');
        for (const cookie of cookies) if (cookie !== original) headers.append('set-cookie', cookie);
        await issue(ctx, { id: session.id, token: session.token, expires_at: session.expiresAt, persistent }, refresh);
      }),
    },
  };
}
