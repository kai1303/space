import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { connect } from 'nats';
import { streamName } from '@space/events';
import { EventBridge } from '@space/event-service/bridge';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { createAuthentication } from '@space/server/auth';
import { huddleMedia } from '@space/server/huddle-media';
import { createAssetStorageFromEnv } from '@space/server/storage';
import { TypesenseSearch } from '@space/server/typesense';
import { collectRoutes } from './coverage.mjs';
import { chatWorkload } from './chat.mjs';
import { scenario } from './scenario.mjs';
import { startConnections } from './connections.mjs';

const rounds = Number(process.env.PERF_ROUNDS ?? 20);
const concurrency = Number(process.env.PERF_CONCURRENCY ?? 1);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100);
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= Math.min(8, rounds));
const scope = process.env.PERF_SCOPE ?? 'chat';
assert.ok(['chat', 'all'].includes(scope), 'PERF_SCOPE must be chat or all');
const broad = scope === 'all';
const probeHeads = process.env.PERF_HEAD_ROUTES === '1';
assert.ok(!probeHeads || broad, 'HEAD route checks require PERF_SCOPE=all');
const metric = process.env.PERF_METRIC ?? 'max';
assert.ok(['max', 'p95'].includes(metric), 'PERF_METRIC must be max or p95');
const instances = Number(process.env.PERF_API_INSTANCES ?? 1);
assert.ok(instances === 1 || (instances === 2 && !broad && concurrency >= 2), 'Two APIs require the chat workload and at least two senders');
const schema = 'perf_' + randomBytes(8).toString('hex');
const url = new URL(process.env.TEST_DATABASE_URL);
const admin = new Pool({ connectionString: url.href });
url.searchParams.set('options', '-c search_path=' + schema);
const pool = new Pool({ connectionString: url.href, max: 20 });
const storage = broad && createAssetStorageFromEnv();
if (broad) assert.ok(storage, 'SeaweedFS configuration required');
const natsUrl = process.env.TEST_NATS_URL ?? process.env.NATS_URL;
assert.ok(natsUrl, 'NATS configuration required');
const bridge = new EventBridge({ databaseUrl: url.href, natsUrl, schema });
const search = { url: process.env.TYPESENSE_URL, apiKey: process.env.TYPESENSE_API_KEY, collection: schema };
const engine = broad && new TypesenseSearch(search);
const office = { url: process.env.ONLYOFFICE_URL, secret: process.env.ONLYOFFICE_JWT_SECRET, callbackBase: 'http://space.test' };
if (broad) assert.ok(office.url && office.secret, 'ONLYOFFICE configuration required');
const origin = 'http://space.test';
const emails = new Map();
const secret = randomBytes(32).toString('hex');
const auth = createAuthentication(pool, { secret, baseURL: origin,
  sendVerificationEmail: async (email, link) => { emails.set(email, link); } });
const media = broad ? huddleMedia() : undefined;
const connections = broad && await startConnections(pool);
const { app, routes: registered } = collectRoutes(() => createApi(new PostgresStore(pool), { auth, ...(broad ? { storage, search, office, huddles: media, outbound: connections.options } : {}),
  trustedProxies: ['127.0.0.1'], realtime: { eventUrl: natsUrl } }));
const keys = new Set();
const samples = new Map();
const coverage = new Set();
const errors = [];
app.addHook('onSend', async (req, reply) => {
  reply.header('x-benchmark-route', req.routeOptions.url || '');
});
const addresses = [];
let replica, replicaExit;
async function measure(area, operation, work) {
  if (area === null) return work();
  const start = performance.now();
  let result;
  try { result = await work(); }
  catch (error) {
    errors.push({ area, operation, elapsed_ms: performance.now() - start, error: error.message });
    throw error;
  }
  const elapsed = performance.now() - start;
  const key = area + ' | ' + operation;
  if (!samples.has(key)) samples.set(key, []);
  samples.get(key).push(elapsed);
  return result;
}
function client(ip, participant = 0, headRoutes) {
  const address = addresses[participant % addresses.length];
  let cookie = '';
  return {
    address,
    get cookie() { return cookie; },
    async call(area, operation, method, path, payload, status = 200, headers = {}) {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const options = { method, body, redirect: 'manual', headers: { origin, cookie,
        'x-forwarded-for': ip, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        signal: AbortSignal.timeout(30000) };
      const { response, bytes } = await measure(area, operation, async () => {
        const response = await fetch(address + path, options);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(response.status, status, operation + ' ' + bytes.toString('utf8', 0, 250));
        return { response, bytes };
      });
      const route = response.headers.get('x-benchmark-route');
      assert.ok(route, operation);
      if (area !== null) coverage.add(method + ' ' + (route === '/v1/auth/*' ? path.split('?')[0] : route));
      const cookies = response.headers.getSetCookie();
      if (cookies.length) cookie = cookies.map(c => c.split(';')[0]).join('; ');
      // HEAD checks run in a separate coverage pass. Keep the same actor and resource
      // while the workflow still owns it. Never replay one-time auth links.
      if (headRoutes && area !== null && method === 'GET' && (status === 200 || status === 302) && route !== '/v1/auth/*'
          && registered.has('HEAD ' + route) && !headRoutes.has(route)) {
        headRoutes.add(route);
        try {
          await measure('HTTP HEAD', route, async () => {
            const reply = await fetch(address + path, {...options, method: 'HEAD', signal: AbortSignal.timeout(30000)});
            assert.equal((await reply.arrayBuffer()).byteLength, 0);
            assert.equal(reply.status, status, 'HEAD ' + route);
            assert.equal(reply.headers.get('x-benchmark-route'), route);
            if (route === '/v1/office/files/:assetId/:revision') assert.equal(reply.headers.get('content-length'), String(bytes.length));
          });
          coverage.add('HEAD ' + route);
        } catch { /* measure records the failure. Continue checking independent routes. */ }
      }
      if (response.status === 302) return response.headers.get('location');
      if (response.headers.get('content-type')?.includes('application/json') && bytes.length) return JSON.parse(bytes);
      return bytes;
    },
  };
}
const started = new Date();
const failures = [];
let completed = 0;
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(pool);
  if (broad) await engine.initialize();
  await bridge.start();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  addresses.push(address);
  if (instances === 2) {
    replica = fork(new URL('./replica.mjs', import.meta.url));
    replicaExit = once(replica, 'exit');
    const ready = once(replica, 'message');
    replica.send({ databaseUrl: url.href, natsUrl, origin, secret });
    const [info] = await Promise.race([ready, replicaExit.then(() => { throw new Error('Second API exited during startup'); })]);
    assert.notEqual(info.address, address);
    addresses.push(info.address);
  }
  if (!broad) {
    completed = await chatWorkload({ origin, client, measure, concurrency, rounds, failures });
  } else {
    let issued = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (issued < rounds) {
        const round = ++issued;
        try {
          const heads = probeHeads ? new Set() : undefined;
          await scenario({ round, address, origin, client: ip => client(ip, 0, heads), measure, keys, emails, pool, engine, office, media, recordRoute(method, path) {
            assert.ok(registered.has(method + ' ' + path));
            coverage.add(method + ' ' + path);
          } });
          completed++;
        } catch (error) {
          failures.push('Round ' + round + ': ' + error.message);
          console.error(error);
        }
      }
    }));
  }
  const operations = [...samples].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => {
    const sorted = values.toSorted((a, b) => a - b);
    const quantile = q => sorted[Math.ceil(q * sorted.length) - 1];
    const [area, operation] = key.split(' | ');
    return { area, operation, n: values.length, p50: quantile(.5), p95: quantile(.95),
      max: sorted.at(-1), breaches: values.filter(ms => ms >= 200).length, samples_ms: values };
  });
  const missing = broad ? [...registered].filter(route => !coverage.has(route)) : [];
  const scenarios = broad ? rounds : rounds * concurrency;
  const pass = !missing.length && !errors.length && !failures.length && completed === scenarios && operations.length > 0 && operations.every(op => op[metric] < 200 && op.n >= scenarios);
  const dir = process.env.PERF_OUTPUT ?? ('test-results/operations/' + scope + '-' + concurrency + (instances === 2 ? '-2api' : ''));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'latency.json'), JSON.stringify({ started, finished: new Date(), node: process.version, scope, rounds, scenarios, completed, concurrency,
    api_instances: instances, api_pids: [process.pid, ...(replica ? [replica.pid] : [])],
    ...(!broad && { sender_api: Array.from({ length: concurrency }, (_, i) => i % instances + 1), receiver_api: concurrency % instances + 1 }),
    threshold_ms: 200, metric, probe_head_routes: probeHeads, pass, failures, errors, missing, routes: [...coverage].sort(), operations }, null, 2) + '\n');
  console.log(JSON.stringify({ pass, missing, rounds, completed, concurrency, operations: operations.length, routes: coverage.size,
    samples: operations.reduce((sum, op) => sum + op.n, 0), slow: operations.filter(op => op[metric] >= 200)
      .map(({ operation, p95, max, breaches }) => ({ operation, p95, max, breaches })), dir }));
  if (!pass) process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  async function cleanup(task) {
    try { await task(); } catch (error) { cleanupErrors.push(error); }
  }
  await cleanup(() => bridge.close());
  if (replica) await cleanup(async () => {
    if (replica.connected) replica.disconnect();
    const [code] = await replicaExit;
    assert.equal(code, 0, 'Second API exited abnormally');
  });
  await cleanup(() => app.close());
  if (connections) await cleanup(() => connections.close());
  for (const key of keys) await cleanup(() => storage.remove(key));
  if (broad) await cleanup(() => engine.removeCollection());
  await cleanup(async () => {
    const nc = await connect({ servers: natsUrl });
    try {
      const manager = await nc.jetstreamManager();
      for (const kind of ['CHAT', 'WORK', 'SEARCH']) {
        try { await manager.streams.delete(streamName(schema) + '_' + kind); }
        catch (error) { if (error.code !== '404') throw error; }
      }
    } finally { await nc.close(); }
  });
  await cleanup(() => pool.end());
  await cleanup(() => admin.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1', [bridge.slot]));
  await cleanup(() => admin.query('DROP PUBLICATION IF EXISTS "' + bridge.publication + '"'));
  await cleanup(() => admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'));
  await cleanup(() => admin.end());
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Benchmark cleanup failed');
}
