import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppError, parseMessageInput, record, text } from '@space/contracts';
import { requireChannelCapability } from './channel-permissions.js';
import type { Database } from './database.js';
import { sessionTransaction } from './session-concurrency.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Hook = { id: string; name: string };

export class ChannelWebhooks {
  constructor(private db: Database) {}

  list(actor: string, channel: string) {
    return sessionTransaction(this.db, async c => {
      await requireChannelCapability(c, actor, channel, 'manage');
      return (await c.execute<Hook>(sql`SELECT id,name FROM channel_webhooks WHERE channel_id=${channel} ORDER BY name,id`)).rows;
    });
  }

  create(actor: string, channel: string, input: unknown) {
    const name = text(record(input, ['name']).name, 80).trim();
    const token = randomBytes(32).toString('base64url');
    return sessionTransaction(this.db, async c => {
      await requireChannelCapability(c, actor, channel, 'manage');
      const { rows } = await c.execute<Hook>(sql`INSERT INTO channel_webhooks(id,channel_id,creator_id,name,token_hash)
        SELECT ${randomUUID()}::uuid,${channel}::uuid,${actor}::uuid,${name},${digest(token)}
        WHERE (SELECT count(*) FROM channel_webhooks WHERE channel_id=${channel}) < 32 RETURNING id,name`);
      if (!rows[0]) throw new AppError(409, 'channel_webhook_limit');
      return { ...rows[0], path: '/v1/hooks/incoming/' + token };
    });
  }

  revoke(actor: string, channel: string, id: string) {
    return sessionTransaction(this.db, async c => {
      await requireChannelCapability(c, actor, channel, 'manage');
      await c.execute(sql`DELETE FROM channel_webhooks WHERE channel_id=${channel} AND id=${id}`);
    });
  }

  post(token: string, key: unknown, input: unknown) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(404, 'not_found');
    if (key !== undefined && (typeof key !== 'string' || !/^[!-~]{1,128}$/.test(key))) throw new AppError(400, 'invalid_idempotency_key');
    const { text: body } = parseMessageInput({ ...record(input, ['text']), client_message_id: randomUUID() });
    const hash = digest(body);
    const retryKey = typeof key === 'string' ? digest(key) : null;
    return sessionTransaction(this.db, async c => {
      const { rows: [hook] } = await c.execute<Hook & { channel_id: string; creator_id: string; workspace_id: string }>(sql`
        SELECT h.id,h.name,h.channel_id,h.creator_id,ch.workspace_id FROM channel_webhooks h JOIN channels ch ON ch.id=h.channel_id
        WHERE h.token_hash=${digest(token)}`);
      if (!hook) throw new AppError(404, 'not_found');
      await requireChannelCapability(c, hook.creator_id, hook.channel_id, 'post');
      if (retryKey) {
        const { rows: [previous] } = await c.execute<{id: string; request_hash: string}>(sql`SELECT id,request_hash FROM messages
          WHERE channel_id=${hook.channel_id} AND webhook_id=${hook.id} AND webhook_key=${retryKey}`);
        if (previous) {
          if (previous.request_hash !== hash) throw new AppError(409, 'idempotency_conflict');
          return { message_id: previous.id };
        }
      }
      const budget = await c.execute(sql`UPDATE channel_webhooks SET
        posts=CASE WHEN window_start <= now()-interval '1 minute' THEN 1 ELSE posts+1 END,
        window_start=CASE WHEN window_start <= now()-interval '1 minute' THEN now() ELSE window_start END
        WHERE id=${hook.id} AND (posts < 120 OR window_start <= now()-interval '1 minute') RETURNING id`);
      if (!budget.rows.length) throw new AppError(429, 'channel_webhook_rate_limit');
      const thread = randomUUID(), id = randomUUID();
      await c.execute(sql`INSERT INTO threads(id,workspace_id,channel_id) VALUES(${thread},${hook.workspace_id},${hook.channel_id})`);
      await c.execute(sql`INSERT INTO messages(id,workspace_id,channel_id,thread_id,author_type,webhook_id,webhook_name,webhook_key,request_hash,text)
        VALUES(${id},${hook.workspace_id},${hook.channel_id},${thread},'app',${hook.id},${hook.name},${retryKey},${hash},${body})`);
      return { message_id: id };
    }, 'serializable', 100);
  }
}
