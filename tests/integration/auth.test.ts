import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { bootstrap } from '@space/postgres/bootstrap';
import { createAuthentication } from '@space/server/auth';
import { createApi } from '@space/server/api';
import { EventBridge } from '@space/event-service/bridge';
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `auth_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const secret = 'test-only-auth-secret-at-least-32-characters';
const auth = createAuthentication(pool, { secret, baseURL: 'http://space.test' });
const app = createApi(new PostgresStore(pool), { auth, realtime: { } });
let address: string, identity = 0;
const password = 'Testing-auth-1234!';
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); address = await app.listen({ host: '127.0.0.1', port: 0 }); });
after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
function cookies(response: { headers: Record<string, unknown> }) {
  const values = response.headers['set-cookie'];
  return (Array.isArray(values) ? values : [String(values ?? '')]).map(value => value.split(';')[0]).join('; ');
}
async function signup() {
  const index = ++identity, email = `person-${index}@example.test`, ip = `127.0.0.${index}`;
  const response = await app.inject({ method: 'POST', url: '/v1/auth/sign-up/email', remoteAddress: ip, headers: { origin: 'http://space.test' }, payload: { name: `Person ${index}`, email, password } });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookies(response), user: response.json().user, email, ip };
}
async function login(email: string, ip: string, secret = password) {
  return app.inject({ method: 'POST', url: '/v1/auth/sign-in/email', remoteAddress: ip, headers: { origin: 'http://space.test' }, payload: { email, password: secret } });
}
async function call(cookie: string, path: string, payload?: object, origin: string | undefined = 'http://space.test') {
  return app.inject({ method: payload ? 'POST' : 'GET', url: `/v1${path}`, headers: { cookie, ...(origin ? { origin } : {}) }, ...(payload ? { payload } : {}) });
}
async function socket(cookie: string, origin = 'http://space.test') {
  const client = io(address, { transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: origin }, reconnection: false });
  try { await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); }); return client; }
  catch (error) { client.disconnect(); throw error; }
}

test('registration persists a hashed password and cookie session without granting memberships', async () => {
  const user = await signup();
  assert.match(user.user.id, /^[0-9a-f-]{36}$/);
  assert.ok(user.cookie.includes('session_token='));
  assert.equal(user.user.name, 'Person 1');
  const account = (await pool.query('SELECT password,user_id FROM auth_accounts WHERE user_id=$1', [user.user.id])).rows[0];
  assert.equal(account.user_id, user.user.id); assert.notEqual(account.password, password); assert.ok(account.password.length > 50);
  const me = await call(user.cookie, '/me'); assert.equal(me.statusCode, 200); assert.equal(me.json().id, user.user.id);
  assert.equal((await call(user.cookie, '/auth/get-session')).json().user.id, user.user.id);
  assert.deepEqual((await call(user.cookie, '/workspaces')).json().items, []);
  assert.equal((await call('', '/me')).statusCode, 401);
  const wrong = await login(user.email, user.ip, 'Wrong-password-123'); assert.equal(wrong.statusCode, 401);
  const valid = await login(user.email.toUpperCase(), user.ip); assert.equal(valid.statusCode, 200); assert.ok(cookies(valid));
  const duplicate = await app.inject({ method: 'POST', url: '/v1/auth/sign-up/email', remoteAddress: user.ip, headers: { origin: 'http://space.test' }, payload: { name: 'Duplicate', email: user.email, password } });
  assert.ok(duplicate.statusCode >= 400 && duplicate.statusCode < 500);
  assert.equal((await pool.query('SELECT count(*) FROM users WHERE email=$1', [user.email])).rows[0].count, '1');
});

test('cookie-authenticated users retain workspace/channel isolation and cannot use legacy tokens', async () => {
  const one = await signup(), two = await signup(), legacy = await bootstrap(pool);
  const workspaceResponse = await call(one.cookie, '/workspaces', { name: 'Private workspace' }); assert.equal(workspaceResponse.statusCode, 201, workspaceResponse.body);
  const workspaces = (await call(one.cookie, '/workspaces')).json().items;
  const channelResponse = await call(one.cookie, `/workspaces/${workspaces[0].id}/channels`, { name: 'Private', private: true });
  assert.equal(channelResponse.statusCode, 201);
  const channel = channelResponse.json();
  assert.equal((await call(two.cookie, `/channels/${channel.id}/history`)).statusCode, 404);
  const message = await call(one.cookie, `/channels/${channel.id}/messages`, { client_message_id: randomUUID(), text: 'Authenticated author' });
  assert.equal(message.json().author.id, one.user.id);
  const bearer = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${legacy.owner_token}` } });
  assert.equal(bearer.statusCode, 401);
  assert.equal((await pool.query('SELECT count(*) FROM workspace_members WHERE user_id=$1', [legacy.owner_id])).rows[0].count, '1');
  const client = await socket(one.cookie);
  try {
    assert.ok((await client.timeout(2000).emitWithAck('channel.subscribe', { channel_id: channel.id, after: '1' })).data);
    const ack = await client.timeout(2000).emitWithAck('message.send', { channel_id: channel.id, client_message_id: randomUUID(), text: 'Session socket' });
    assert.equal(ack.data.author.id, one.user.id);
  } finally { client.disconnect(); }
});

test('email login issues a persistent JWT that restores only its live session', async () => {
  const user = await signup();
  const response = await login(user.email, user.ip);
  assert.equal(response.statusCode, 200);
  const cookie = response.cookies.find(cookie => cookie.name === 'better-auth.session_token')!;
  assert.ok(cookie.httpOnly);
  assert.equal(cookie.maxAge, 15 * 60);
  const parts = cookie.value.split('.');
  assert.equal(parts.length, 3);
  const [, payload, signature] = parts;
  assert.ok(payload && signature);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, 'http://space.test');
  assert.ok(claims.exp - claims.iat === 15 * 60);
  const saved = cookies(response);
  assert.equal((await call(saved, '/auth/get-session')).json().user.id, user.user.id);
  const altered = saved.replace(signature, (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1));
  assert.equal((await call(altered, '/auth/get-session')).json(), null);
  assert.equal((await call(altered, '/me')).statusCode, 401);
  await assert.rejects(socket(altered), /unauthorized/);
  assert.equal((await call(saved, '/auth/sign-out', {})).statusCode, 200);
  assert.equal((await call(saved, '/auth/get-session')).json(), null);
});

test('refresh-only startup rotates credentials atomically across tabs and preserves the session deadline', async () => {
  const user = await signup();
  const initial = user.cookie.split('; ').find(cookie => cookie.startsWith('space.refresh='))!;
  const check = await call(initial, '/auth/get-session');
  assert.equal(check.json(), null);
  assert.equal(check.headers['x-space-refresh-available'], '1');
  assert.equal((await call(initial, '/me')).statusCode, 401);
  assert.equal((await call(initial, '/auth/refresh', {}, 'https://other.test')).statusCode, 403);
  const wrongSession = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: {
    origin: 'http://space.test', cookie: initial, 'x-space-session-id': randomUUID(),
  }, payload: {} });
  assert.equal(wrongSession.statusCode, 401);
  const replies = await Promise.all(Array.from({ length: 4 }, () => call(initial, '/auth/refresh', {})));
  for (const reply of replies) assert.equal(reply.statusCode, 200, reply.body);
  const tokens = replies.map(reply => reply.cookies.find(cookie => cookie.name === 'space.refresh')!);
  const next = 'space.refresh=' + tokens[0]!.value;
  assert.notEqual(next, initial);
  assert.ok(tokens.every(token => token.value === tokens[0]!.value && token.httpOnly && token.path === '/v1/auth'));
  assert.ok(Math.abs(tokens[0]!.maxAge! - 30 * 86400) <= 5);
  const saved = cookies(replies[0]!);
  const restored = await call(saved, '/auth/get-session');
  assert.equal(restored.json().user.id, user.user.id);
  assert.equal(restored.headers['x-space-session-id'], restored.json().session.id);
  assert.equal((await call(saved, '/me')).statusCode, 200);
  const client = await socket(saved); client.disconnect();

  await pool.query("UPDATE auth_session_refresh SET rotated_at=now()-interval '1 minute' WHERE session_id=$1", [restored.json().session.id]);
  const stale = await call(initial, '/auth/refresh', {});
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.headers['set-cookie'], undefined);
  const renewed = await call(next, '/auth/refresh', {});
  assert.equal(renewed.statusCode, 200);
  const latest = renewed.cookies.find(cookie => cookie.name === 'space.refresh')!;
  assert.notEqual(latest.value, tokens[0]!.value);
  const loggedOut = await call('space.refresh=' + latest.value, '/auth/sign-out', {});
  assert.equal(loggedOut.statusCode, 200);
  assert.ok(loggedOut.cookies.some(cookie => cookie.name === 'space.refresh' && cookie.maxAge === 0));
  assert.equal((await call(saved, '/me')).statusCode, 401);
  assert.equal((await call('space.refresh=' + latest.value, '/auth/refresh', {})).statusCode, 401);
});

test('an expired access JWT requires rotation while the refresh session is live', async t => {
  const user = await signup();
  const clock = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: clock });
  t.mock.timers.setTime(clock + 16 * 60_000);
  assert.equal((await call(user.cookie, '/me')).statusCode, 401);
  assert.equal((await call(user.cookie, '/auth/get-session')).json(), null);
  const renewed = await call(user.cookie, '/auth/refresh', {});
  assert.equal(renewed.statusCode, 200);
  assert.equal((await call(cookies(renewed), '/me')).json().id, user.user.id);
});

test('nonpersistent sign-in stays browser-only and refresh cannot outlive the database session', async () => {
  const user = await signup();
  const response = await app.inject({ method: 'POST', url: '/v1/auth/sign-in/email', remoteAddress: user.ip,
    headers: { origin: 'http://space.test' }, payload: { email: user.email, password, rememberMe: false } });
  const saved = cookies(response);
  const renewed = await call(saved, '/auth/refresh', {});
  assert.equal(renewed.statusCode, 200, renewed.body);
  for (const cookie of renewed.cookies) assert.equal(cookie.maxAge, undefined);
  await pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [user.user.id]);
  assert.equal((await call(cookies(renewed), '/auth/refresh', {})).statusCode, 401);
});

test('pre-upgrade signed cookies restore only a live Better Auth session', async () => {
  const user = await signup();
  const { token } = (await pool.query('SELECT token FROM auth_sessions WHERE user_id=$1', [user.user.id])).rows[0];
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  const legacy = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  assert.equal((await call(legacy, '/auth/get-session')).json().user.id, user.user.id);
  assert.equal((await call(legacy, '/auth/sign-out', {})).statusCode, 200);
  assert.equal((await call(legacy, '/me')).statusCode, 401);
});

test('logout disconnects an idle socket and revokes its cookie immediately', { timeout: 15000 }, async t => {
  const bridge = new EventBridge({ databaseUrl: url!, schema, natsUrl: process.env.NATS_URL ?? process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222' });
  t.after(async () => {
    await bridge.close();
    await admin.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1', [bridge.slot]);
    await admin.query(`DROP PUBLICATION IF EXISTS "${bridge.publication}"`);
  });
  await bridge.start();
  const user = await signup(), client = await socket(user.cookie);
  try {
    const closed = new Promise(resolve => client.once('disconnect', resolve));
    assert.equal((await call(user.cookie, '/auth/sign-out', {})).statusCode, 200);
    assert.equal((await call(user.cookie, '/me')).statusCode, 401);
    await closed;
    await assert.rejects(socket(user.cookie), /unauthorized/);
  } finally { client.disconnect(); }
});

test('expired and revoked sessions are rejected by HTTP and Socket.IO', async () => {
  const user = await signup();
  await pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [user.user.id]);
  assert.equal((await call(user.cookie, '/me')).statusCode, 401);
  await assert.rejects(socket(user.cookie), /unauthorized/);
  const first = await login(user.email, user.ip), second = await login(user.email, user.ip);
  assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200);
  const revoked = await call(cookies(first), '/auth/revoke-sessions', {}); assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await call(cookies(second), '/me')).statusCode, 401);
  assert.equal((await call(cookies(second), '/auth/refresh', {})).statusCode, 401);
});

test('origin checks reject cross-site cookie writes and WebSocket hijacking', async () => {
  const user = await signup();
  assert.equal((await call(user.cookie, '/workspaces', { name: 'Forged' }, 'https://evil.example')).statusCode, 403);
  const missing = await app.inject({ method: 'POST', url: '/v1/workspaces', headers: { cookie: user.cookie }, payload: { name: 'No origin' } });
  assert.equal(missing.statusCode, 403);
  assert.equal((await call(user.cookie, '/auth/sign-out', {}, 'https://evil.example')).statusCode, 403);
  await assert.rejects(socket(user.cookie, 'https://evil.example'));
  assert.equal((await call(user.cookie, '/me')).statusCode, 200);
});

test('auth rate limits cannot be bypassed with client-supplied IP headers', async () => {
  let limited = false;
  for (let index = 0; index < 12; index++) {
    const response = await app.inject({ method: 'POST', url: '/v1/auth/sign-in/email', remoteAddress: '127.0.0.240', headers: { origin: 'http://space.test', 'x-space-client-ip': `10.0.0.${index}`, 'x-forwarded-for': `10.0.1.${index}` }, payload: { email: 'missing@example.test', password } });
    if (response.statusCode === 429) { limited = true; break; }
    assert.equal(response.statusCode, 401, response.body);
  }
  assert.ok(limited);
});

test('password changes reject the previous password and revoke other sessions', async () => {
  const user = await signup(), another = await login(user.email, user.ip);
  const nextPassword = 'New-testing-password-1234!';
  const changed = await call(user.cookie, '/auth/change-password', { currentPassword: password, newPassword: nextPassword, revokeOtherSessions: true });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await login(user.email, user.ip)).statusCode, 401);
  assert.equal((await login(user.email, user.ip, nextPassword)).statusCode, 200);
  assert.equal((await call(cookies(another), '/me')).statusCode, 401);
});

test('registration cannot claim an existing UUID or mark its own email verified', async () => {
  const legacy = await bootstrap(pool);
  const response = await app.inject({ method: 'POST', url: '/v1/auth/sign-up/email', remoteAddress: '127.0.0.230', headers: { origin: 'http://space.test' }, payload: { name: 'Claim attempt', email: 'claim@example.test', password, id: legacy.owner_id, emailVerified: true } });
  assert.equal(response.statusCode, 200, response.body);
  assert.notEqual(response.json().user.id, legacy.owner_id);
  assert.equal(response.json().user.emailVerified, false);
  assert.deepEqual((await call(cookies(response), '/workspaces')).json().items, []);
});

test('adding a workspace member by email requires proof of email ownership', async () => {
  const owner = await signup(), claimed = await signup();
  const workspace = await call(owner.cookie, '/workspaces', { name: 'Verified membership' });
  assert.equal(workspace.statusCode, 201, workspace.body);
  const path = `/workspaces/${workspace.json().id}/members`;
  const add = () => call(owner.cookie, path, { email: claimed.email.toUpperCase(), role: 'member' });
  const denied = await add();
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error, 'account_email_unverified');
  assert.deepEqual((await call(claimed.cookie, '/workspaces')).json().items, []);
  await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [claimed.user.id]);
  assert.equal((await add()).statusCode, 201);
  assert.equal((await call(claimed.cookie, `/workspaces/${workspace.json().id}`)).statusCode, 200);
});

test('HTTPS configuration issues Secure HttpOnly cookies; trusted proxy IPs are explicit', async () => {
  const secure = createApi(new PostgresStore(pool), {
    auth: createAuthentication(pool, { secret: 'https-test-secret-at-least-32-characters', baseURL: 'https://space.example' }),
    trustedProxies: ['127.0.0.1'],
  });
  try {
    const response = await secure.inject({ method: 'POST', url: '/v1/auth/sign-up/email', remoteAddress: '127.0.0.1', headers: { origin: 'https://space.example', 'x-forwarded-for': '203.0.113.21', 'x-space-client-ip': '198.51.100.5' }, payload: { name: 'Secure', email: 'secure@example.test', password } });
    assert.equal(response.statusCode, 200, response.body);
    const setCookie = String(response.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /; Secure/i); assert.match(setCookie, /SameSite=Lax/i);
    const session = (await pool.query('SELECT ip_address FROM auth_sessions WHERE user_id=$1', [response.json().user.id])).rows[0];
    assert.equal(session.ip_address, '203.0.113.21');
  } finally { await secure.close(); }
});

test('production rejects legacy token mode and insecure auth configuration', () => {
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => createApi(new PostgresStore(pool), { allowDevelopmentTokens: true }), /forbidden in production/);
    assert.throws(() => createAuthentication(pool, { secret: 'production-test-secret-at-least-32-characters', baseURL: 'http://space.example' }), /HTTPS/);
    assert.throws(() => createAuthentication(pool, { secret: 'short', baseURL: 'https://space.example' }), /32 characters/);
  } finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
});
