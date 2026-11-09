const http = require('node:http');
const { readFile, statfs } = require('node:fs/promises');

// Compose always runs these consumers in its public schema. Optional features
// contribute only their fixed names. Per-installation and ephemeral IDs stay private.
const required = {
  WORK: ['remote-workers', 'navigator-workers', 'call-deadlines', 'todo-reminders',
    'connection-deadlines', 'delivery-deadlines', 'asset-deadlines',
    'workspace-retention-backfill', 'workspace-retention-messages', 'workspace-retention-assets'],
  SEARCH: ['message-search-v1'],
};
const optional = { WORK: ['channel-huddles', 'invitation-emails'], SEARCH: [] };

function sample(name, value, labels = '') {
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid sample');
  return `${name}${labels} ${value}\n`;
}

function jetstreamMetrics(report, prefix) {
  const account = report.account_details.find(account => account.id === '$G');
  if (!account) throw new Error('missing account');
  let metrics = sample('space_jetstream_store_used_bytes', report.storage)
    + sample('space_jetstream_store_limit_bytes', report.config.max_storage);
  for (const [stream, names] of Object.entries(required)) {
    const info = account.stream_detail?.find(s => s.name === `${prefix}_${stream}`);
    for (const name of [...names, ...optional[stream]]) {
      const consumer = info?.consumer_detail?.find(c => c.name === name);
      const labels = `{stream="${stream}",consumer="${name}"}`;
      if (!consumer && !names.includes(name)) continue;
      metrics += sample('space_jetstream_consumer_present', Number(Boolean(consumer)), labels);
      if (!consumer) continue;
      metrics += sample('space_jetstream_consumer_pending', consumer.num_pending, labels)
        + sample('space_jetstream_consumer_ack_pending', consumer.num_ack_pending, labels)
        + sample('space_jetstream_consumer_ack_floor', consumer.ack_floor.consumer_seq, labels)
        + sample('space_jetstream_consumer_redelivered', consumer.num_redelivered, labels);
    }
  }
  return metrics;
}

async function broker(prefix) {
  const response = await fetch('http://nats:8222/jsz?acc=%24G&streams=true&consumers=true&config=false', {
    signal: AbortSignal.timeout(1800), redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('broker probe failed');
  }
  // An oversized broker response must fail this source, never truncate the consumer set.
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 512 * 1024) throw new Error('broker response too large');
    chunks.push(chunk);
  }
  return jetstreamMetrics(JSON.parse(Buffer.concat(chunks).toString('utf8')), prefix);
}

async function postgres(pool, slot) {
  const client = await pool.connect();
  let failed;
  try {
    const { rows: [row] } = await client.query(`
      SELECT COALESCE((SELECT GREATEST(0, EXTRACT(epoch FROM now() - created_at))::float8
                         FROM public.event_outbox ORDER BY created_at LIMIT 1), 0) AS age,
             COALESCE(active AND wal_status <> 'lost', false) AS active,
             COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::float8 AS retained
        FROM (VALUES (1)) AS probe(n)
        LEFT JOIN pg_replication_slots ON slot_name = $1 AND database = current_database()`, [slot]);
    return sample('space_cdc_outbox_oldest_age_seconds', row.age)
      + sample('space_cdc_slot_active', Number(row.active))
      + sample('space_cdc_slot_retained_wal_bytes', row.retained);
  } catch (error) {
    // A client-side timeout can leave the socket executing the previous query.
    failed = error;
    throw error;
  } finally {
    client.release(failed);
  }
}

async function volumeMetrics() {
  let metrics = '';
  for (const volume of ['postgres', 'nats']) {
    const fs = await statfs(`/volumes/${volume}`, { bigint: true });
    const labels = `{volume="${volume}"}`;
    metrics += sample('space_volume_available_bytes', Number(fs.bavail * fs.bsize), labels)
      + sample('space_volume_capacity_bytes', Number(fs.blocks * fs.bsize), labels);
  }
  return metrics;
}

// statfs cannot be cancelled if the underlying device hangs. Skip new reads
// while that operation is pending and continue collecting the other sources.
function boundedDiskProbe(collect, timeoutMs) {
  let running = false;
  return async () => {
    if (running) throw new Error('disk probe pending');
    running = true;
    let timer;
    const measurement = collect().finally(() => { running = false; });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('disk probe timeout')), timeoutMs);
    });
    try { return await Promise.race([measurement, deadline]); }
    finally { clearTimeout(timer); }
  };
}

async function readiness() {
  const response = await fetch('http://server:3000/readyz', {
    signal: AbortSignal.timeout(1800), redirect: 'manual',
  });
  await response.body?.cancel();
  return sample('space_api_ready', Number(response.status === 200));
}

async function scrape(sources) {
  const probes = await Promise.all(Object.entries(sources).map(async ([name, collect]) => {
    const label = `{source="${name}"}`;
    try { return await collect() + sample('space_infra_source_up', 1, label); }
    catch {
      return sample('space_infra_source_up', 0, label) + (name === 'api' ? sample('space_api_ready', 0) : '');
    }
  }));
  return probes.join('');
}

async function main() {
  const { Pool } = require('pg');
  const { streamName } = await import('@space/events');
  const pool = new Pool({
    host: 'postgres', database: 'workplace', user: 'space_infra_monitor',
    password: await readFile('/credentials/password', 'utf8'),
    connectionTimeoutMillis: 1000, query_timeout: 1800, max: 1, idleTimeoutMillis: 15000,
  });
  pool.on('error', () => console.error('metrics database connection closed'));
  const slot = streamName('*').toLowerCase() + '_cdc';
  const sources = {
    postgres: () => postgres(pool, slot), nats: () => broker(streamName('public')),
    disk: boundedDiskProbe(volumeMetrics, 1800), api: readiness,
  };
  let collecting = false;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    if (req.url !== '/metrics' || req.method !== 'GET') { res.writeHead(404).end(); return; }
    if (collecting) { res.writeHead(503).end(); return; }
    collecting = true;
    try {
      const body = await scrape(sources);
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }).end(body);
    } finally { collecting = false; }
  });
  server.maxConnections = 8;
  server.setTimeout(5000);
  server.listen(9798, '0.0.0.0');
}

if (require.main === module) main().catch(() => { console.error('metrics startup failed'); process.exitCode = 1; });
module.exports = { boundedDiskProbe, jetstreamMetrics, scrape };
