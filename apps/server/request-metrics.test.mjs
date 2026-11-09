import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { createApi } from './dist/api.js';

const host = '127.0.0.1';
async function occupyPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

function buildApi(monitoring) {
  const events = {
    start: async () => {},
    subscribe: async () => async () => {},
    subscribeTransient: async () => () => {},
    onReconnect: () => () => {},
  };
  return createApi({
    pool: {
      query: async sql => ({ rows: sql.includes('current_schema') ? [{ schema: 'metrics_test' }] : [] }),
      connect: async () => Object.assign(new EventEmitter(), { query: async () => {}, release() {} }),
    },
    authenticate: async () => 'actor',
    health: async () => {},
    readTask: async () => { throw new Error('sensitive-database-error'); },
  }, { monitoring, realtime: { events }, allowDevelopmentTokens: true });
}

test('private scrape aggregates completed requests without exposing request data on either listener', async t => {
  const reserved = await occupyPort();
  await reserved.close();
  const app = buildApi({ host, port: reserved.port });
  t.after(() => app.close());
  const publicUrl = await app.listen({ host, port: 0 });
  const headers = { authorization: 'Bearer sensitive-credential', cookie: 'session=sensitive-cookie' };
  const path = '/v1/tasks/sensitive-task-id?sensitive-query=private';
  await Promise.all(Array.from({ length: 6 }, () => fetch(publicUrl + path, { headers })));
  const failed = await fetch(publicUrl + '/v1/tasks/9128ea4e-ba31-4b7e-af26-4d63ef1a4052', { headers });
  assert.equal(failed.status, 500);
  await fetch(publicUrl + '/sensitive-unmatched-path', { headers });
  const publicScrape = await fetch(publicUrl + '/metrics', { headers });
  assert.equal(publicScrape.status, 404);
  const privateUrl = 'http://' + host + ':' + reserved.port;
  const response = await fetch(privateUrl + '/metrics');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  const body = await response.text();
  assert.match(body, /space_api_http_requests_total\{method="GET",route="\/v1\/tasks\/:taskId",status_class="4xx"\} 6\n/);
  assert.match(body, /space_api_http_requests_total\{method="GET",route="unmatched",status_class="4xx"\} 2\n/);
  assert.match(body, /space_api_http_requests_total\{method="GET",route="\/v1\/tasks\/:taskId",status_class="5xx"\} 1\n/);
  assert.match(body, /space_api_http_request_duration_seconds_count\{method="GET",route="\/v1\/tasks\/:taskId"\} 7\n/);
  assert.match(body, /space_api_http_request_duration_seconds_bucket\{/);
  assert.doesNotMatch(body, /sensitive|private|session=|Bearer|actor_id|request_id/);
  assert.equal((await fetch(privateUrl + '/v1/tasks')).status, 404);
});

test('an occupied monitoring port leaves the API available', async t => {
  const reserved = await occupyPort();
  t.after(reserved.close);
  const app = buildApi({ host, port: reserved.port });
  t.after(() => app.close());
  assert.equal((await app.inject('/healthz')).statusCode, 200);
});

for (const enabled of [false, true]) {
  test(`monitoring ${enabled ? 'on' : 'off'} controls completion logs and excludes probe traffic`, async t => {
    const app = buildApi(enabled ? { host, port: 0 } : undefined);
    t.after(() => app.close());
    const info = t.mock.method(app.log, 'info', () => {});
    for (const method of ['GET', 'HEAD']) {
      for (const url of ['/readyz', '/healthz']) await app.inject({ method, url });
    }
    const reply = await app.inject({
      method: 'POST', url: '/sensitive-path?sensitive-query=secret',
      headers: { authorization: 'Bearer sensitive-token', cookie: 'session=sensitive-cookie' },
      payload: { text: 'sensitive-message' },
    });
    assert.equal(reply.statusCode, 404);
    const events = info.mock.calls.map(call => call.arguments).filter(([, msg]) => msg === 'http_request_completed');
    assert.equal(events.length, enabled ? 1 : 0);
    if (enabled) {
      const [[fields]] = events;
      assert.ok(Number.isSafeInteger(fields.durationMs) && fields.durationMs >= 0);
      assert.deepEqual(fields, { httpMethod: 'POST', statusCode: 404, durationMs: fields.durationMs });
    }
  });
}

test('private monitoring exposes the live confirmed receipt histogram', async t => {
  const port = await occupyPort();
  await port.close();
  const app = buildApi({ host, port: port.port });
  t.after(() => app.close());
  await app.ready();
  const body = await (await fetch('http://' + host + ':' + port.port + '/metrics')).text();
  assert.match(body, /# TYPE space_chat_live_confirmed_receipt_seconds histogram/);
  assert.match(body, /# TYPE space_chat_live_receipt_samples_total counter/);
  assert.match(body, /space_chat_live_receipt_samples_total\{outcome="confirmed"\} 0\n/);
});
