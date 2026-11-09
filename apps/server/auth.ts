import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { betterAuth } from 'better-auth/minimal';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { database } from '@space/postgres/database';
import { users, authSessions, authAccounts, authVerifications, authRateLimits } from '@space/postgres/schema';
import { AppError } from '@space/contracts';
import { browserSessions } from './session-jwt.js';

export interface Authentication {
  handler(request: Request): Promise<Response>;
  actor(headers: IncomingHttpHeaders): Promise<string | undefined>;
  baseURL: string;
  origins: ReadonlySet<string>;
}
export function createAuthentication(pool: Parameters<typeof database>[0], options: { secret: string; baseURL: string; trustedOrigins?: string[]; sendVerificationEmail?: (email:string,url:string)=>Promise<void> }): Authentication {
  if (options.secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const base = new URL(options.baseURL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid BETTER_AUTH_URL');
  if (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') throw new Error('BETTER_AUTH_URL must use HTTPS in production');
  const origins = new Set([base.origin, ...(options.trustedOrigins ?? []).map(origin => new URL(origin).origin)]);
  const validateName = (name: unknown) => {
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || name.includes('\0')) throw new APIError('BAD_REQUEST', { message: 'Name must contain 1–100 characters.' });
    return name.trim();
  };
  const sessions = browserSessions(pool, options.secret, base.origin, origins);
  const auth = betterAuth({
    appName: 'Space', secret: options.secret, baseURL: base.origin, basePath: '/v1/auth',
    trustedOrigins: [...origins],
    hooks: sessions.hooks, plugins: [sessions.plugin],
    database: drizzleAdapter(database(pool), { provider: 'pg', transaction: true,
      schema: { user: users, session: authSessions, account: authAccounts, verification: authVerifications, rateLimit: authRateLimits } }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    emailVerification: { sendOnSignUp: false, sendVerificationEmail: async ({user,url}) => {
      if(!options.sendVerificationEmail) throw new APIError('SERVICE_UNAVAILABLE',{message:'Email delivery is not configured. Contact your workspace administrator.'});
      await options.sendVerificationEmail(user.email,url);
    } },
    user: { fields: { name: 'display_name', emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' } },
    session: { expiresIn: 60 * 60 * 24 * 30, disableSessionRefresh: true, cookieCache: { enabled: false } },
    advanced: { database: { generateId: () => randomUUID() }, useSecureCookies: base.protocol === 'https:', ipAddress: { ipAddressHeaders: ['x-space-client-ip'] } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 10 }, '/sign-up/email': { window: 60, max: 5 }, '/send-verification-email': {window:60,max:3} } },
    databaseHooks: { user: {
      create: { before: async user => ({ data: { ...user, name: validateName(user.name) } }) },
      update: { before: async user => ({ data: { ...user, ...(user.name === undefined ? {} : { name: validateName(user.name) }) } }) },
    } },
    logger: { disabled: true },
  });
  return {
    baseURL: base.origin, origins, handler: request => auth.handler(request),
    async actor(headers) {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(headers), query: { disableCookieCache: true } });
      return session?.user.id;
    },
  };
}
export function registerAuthRoutes(app: FastifyInstance, auth: Authentication) {
  app.route({ method: ['GET', 'POST'], url: '/v1/auth/*', async handler(request, reply) {
    const headers = fromNodeHeaders(request.headers);
    // Never trust client-supplied forwarding headers for the auth rate limiter.
    headers.set('x-space-client-ip', request.ip);
    const response = await auth.handler(new Request(new URL(request.url, auth.baseURL), {
      method: request.method, headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    }));
    reply.code(response.status);
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value); });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    return reply.send(await response.text());
  } });
}
export function assertTrustedOrigin(auth: Authentication, origin: string | undefined) {
  if (!origin || !auth.origins.has(origin)) throw new AppError(403, 'untrusted_origin');
}
