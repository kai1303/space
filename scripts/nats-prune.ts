// Deletes JetStream streams that belong to no live Space schema.
// Every schema gets its own SPACE_<hash>_{CHAT,WORK,SEARCH} streams, and each CHAT stream reserves 16 MB of
// broker storage. Test runs create a schema each and often never remove its streams, so a dev broker fills
// its file store with empty reservations and then refuses new streams ("insufficient storage resources").
//
//   PRUNE_DATABASE_URLS=postgres://...,postgres://... NATS_URL=nats://127.0.0.1:54222 pnpm nats:prune           (dry run)
//   PRUNE_DATABASE_URLS=... NATS_URL=... pnpm nats:prune -- --delete
//
// A stream is kept when its hash matches any schema name or database name found in the given databases,
// or `*` (the all-schemas bridge). Streams that do not follow the SPACE_<hash>_<KIND> pattern are never touched.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { connect } from 'nats';

const hash = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, 24);
const pattern = /^SPACE_([0-9a-f]{24})_(CHAT|WORK|SEARCH)$/;

const urls = (process.env.PRUNE_DATABASE_URLS ?? process.env.DATABASE_URL ?? '').split(',').map(u => u.trim()).filter(Boolean);
if (!urls.length) throw new Error('Set PRUNE_DATABASE_URLS (comma-separated) or DATABASE_URL');
const remove = process.argv.includes('--delete');

const keep = new Set([hash('*')]);
for (const url of urls) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      "SELECT nspname AS name FROM pg_namespace WHERE nspname !~ '^(pg_|information_schema)' UNION SELECT datname FROM pg_database WHERE NOT datistemplate");
    for (const row of rows) keep.add(hash(row.name));
  } finally { await client.end(); }
}

const nc = await connect({ servers: process.env.NATS_URL ?? 'nats://127.0.0.1:54222' });
try {
  const manager = await nc.jetstreamManager();
  let kept = 0, reserved = 0;
  const stale: string[] = [];
  // List everything first: deleting while paging shifts the pages and skips streams.
  for await (const info of manager.streams.list()) {
    const match = pattern.exec(info.config.name);
    if (!match || keep.has(match[1]!)) { kept++; continue; }
    stale.push(info.config.name);
    reserved += Math.max(info.config.max_bytes, 0);
  }
  const pruned = stale.length;
  if (remove) for (const name of stale) await manager.streams.delete(name).catch(error => { if ((error as { code?: string }).code !== '404') throw error; });
  console.log(`${remove ? 'Deleted' : 'Would delete'} ${pruned} streams (${Math.round(reserved / 1024 ** 2)} MB reserved); kept ${kept}.${remove ? '' : ' Run again with --delete to remove them.'}`);
} finally { await nc.close(); }
