import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { authorize, validateTokens, refreshCredentials } from '../dist/oauth.js';

const identity = { client_id: 'oaiapp_test', subject: 'user-1', issuer: 'https://auth.openai.com' };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), alg: 'RS256', kid: 'test' }] });
async function response(claims = {}, options = {}) {
  const id_token = await new SignJWT({ nonce: 'nonce', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(identity.issuer).setAudience(identity.client_id).setSubject('user-1').setExpirationTime('5m').sign(privateKey);
  return { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid resource.invoke chatgpt.tokens.use.direct', id_token, ...options };
}
test('validates signature, issued audience, nonce, identity and both plan scopes', async () => {
  const tokens = await response();
  const saved = await validateTokens(tokens, identity.client_id, { nonce: 'nonce', keys: jwks });
  assert.equal(saved.subject, 'user-1');
  await assert.rejects(validateTokens(tokens, identity.client_id, { nonce: 'wrong', keys: jwks }), /nonce/);
  await assert.rejects(validateTokens(tokens, 'other-client', { nonce: 'nonce', keys: jwks }));
  await assert.rejects(validateTokens(tokens, identity.client_id, { nonce: 'nonce', keys: jwks, subject: 'another-user' }), /identity/);
  await assert.rejects(validateTokens(await response({}, { scope: 'openid chatgpt.tokens.use.direct' }), identity.client_id, { nonce: 'nonce', keys: jwks }), /permission/);
});

test('loopback OAuth uses issued callback client, exact redirect and PKCE', async () => {
  let authorizeUrl, form;
  const saved = await authorize('urn:uuid:test', undefined, {
    keys: jwks,
    announce: async url => {
      authorizeUrl = new URL(url);
      assert.equal(authorizeUrl.searchParams.get('client_id'), 'dynamic_agent_client');
      const callback = new URL(authorizeUrl.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      assert.equal(callback.pathname, '/auth/callback');
      callback.searchParams.set('state', authorizeUrl.searchParams.get('state'));
      callback.searchParams.set('code', 'authorization-code');
      callback.searchParams.set('client_id', identity.client_id);
      await fetch(callback);
    },
    fetch: async (_url, options) => {
      form = new URLSearchParams(options.body);
      return Response.json(await response({ nonce: authorizeUrl.searchParams.get('nonce') }));
    }
  });
  assert.equal(saved.client_id, identity.client_id);
  assert.equal(form.get('client_id'), identity.client_id);
  assert.equal(form.get('redirect_uri'), authorizeUrl.searchParams.get('redirect_uri'));
  assert.equal(form.get('resource'), 'https://api.openai.com/v1');
  assert.ok(form.get('code_verifier').length >= 43);
});

test('rejects a callback for another state without exchanging credentials', async () => {
  await assert.rejects(authorize('urn:uuid:test', undefined, {
    keys: jwks,
    announce: async url => {
      const callback = new URL(new URL(url).searchParams.get('redirect_uri'));
      callback.search = 'state=wrong&code=code&client_id=oaiapp_test';
      await fetch(callback);
    },
    fetch: async () => { assert.fail('must not exchange'); },
  }), /state/);
});

test('refresh replaces rotated refresh token and preserves identity', async () => {
  const current = await validateTokens(await response(), identity.client_id, { nonce: 'nonce', keys: jwks });
  const refreshed = await refreshCredentials(current, { keys: jwks, fetch: async (_url, options) => {
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'refresh');
    assert.equal(form.has('scope'), false);
    return Response.json(await response({}, { refresh_token: 'rotated' }));
  } });
  assert.equal(refreshed.refresh_token, 'rotated');
});

test('returning registration rejects another client before token exchange', async () => {
  await assert.rejects(authorize('urn:uuid:test', identity, {
    announce: async url => {
      const authorization = new URL(url);
      assert.equal(authorization.searchParams.has('agent_name_hint'), false);
      assert.equal(authorization.searchParams.has('id_token_hint'), false);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      callback.searchParams.set('code', 'code');
      callback.searchParams.set('client_id', 'other-client');
      await fetch(callback);
    }, fetch: async () => { assert.fail('must not exchange'); }, keys: jwks,
  }), /client/);
});

test('OAuth denial never exchanges a code', async () => {
  await assert.rejects(authorize('urn:uuid:test', undefined, {
    announce: async url => {
      const authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      callback.searchParams.set('error', 'access_denied');
      await fetch(callback);
    }, fetch: async () => { assert.fail('must not exchange'); },
  }), /declined/);
});

test('rejects expired tokens and unsigned ID tokens', async () => {
  const expired = await new SignJWT({ nonce: 'nonce' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(identity.issuer).setAudience(identity.client_id).setSubject('user-1').setExpirationTime('0s').sign(privateKey);
  await assert.rejects(validateTokens(await response({}, { id_token: expired }), identity.client_id, { keys: jwks }));
  await assert.rejects(validateTokens(await response({}, { id_token: 'e30.e30.' }), identity.client_id, { keys: jwks }));
});

test('expired credentials recover after network and service failures on wake', async t => {
  const current = await validateTokens(await response(), identity.client_id, { keys: jwks });
  current.expires_at = Date.now() - 60_000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const delays = [];
  const refreshed = await refreshCredentials(current, {
    fetch: async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      if (calls === 2) return new Response(null, { status: 503 });
      return Response.json({ access_token: 'new', token_type: 'Bearer', expires_in: 3600 });
    },
    onRetry: (_reason, delay) => {
      delays.push(delay);
      queueMicrotask(() => t.mock.timers.tick(delay));
    },
  });
  assert.equal(refreshed.access_token, 'new');
  assert.equal(calls, 3);
  assert.ok(delays[0] > 0 && delays[1] > delays[0]);
});

test('rejected refresh credentials request sign-in without retrying or logging the response body', async () => {
  const current = await validateTokens(await response(), identity.client_id, { keys: jwks });
  let calls = 0;
  await assert.rejects(refreshCredentials(current, {
    fetch: async () => {
      calls++;
      return new Response('sensitive response body', { status: 401 });
    },
  }), error => /401.*--login/.test(error.message) && !error.message.includes('sensitive'));
  assert.equal(calls, 1);
});

test('shutdown interrupts the renewal delay before another exchange', async () => {
  const current = await validateTokens(await response(), identity.client_id, { keys: jwks });
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(refreshCredentials(current, {
    signal: controller.signal,
    fetch: async () => { calls++; return new Response(null, { status: 429 }); },
    onRetry: () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('a persistent outage exhausts a bounded retry budget', async t => {
  const current = await validateTokens(await response(), identity.client_id, { keys: jwks });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  await assert.rejects(refreshCredentials(current, {
    fetch: async () => { calls++; return new Response(null, { status: 503 }); },
    onRetry: (_reason, delay) => queueMicrotask(() => t.mock.timers.tick(delay)),
  }), /503.*[Rr]estart/);
  assert.equal(calls, 5);
});
