import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppError, record, text, uuid, type DmDevice, type DmEncryption } from '@space/contracts';
import { hasChannelAccess } from './access.js';
import type { Database, DbSession } from './database.js';
import { sessionTransaction } from './session-concurrency.js';

async function visible(c: DbSession, actor: string, id: string) {
  const row = (
    await c.execute<{
      workspace_id: string;
      enabled: boolean;
      participants: string[];
    }>(sql`SELECT workspace_id,encrypted_since IS NOT NULL AS enabled,
    ARRAY[direct_user_low,direct_user_high] AS participants FROM channels WHERE id=${uuid(id)} AND kind='direct'`)
  ).rows[0];
  if (!row || !row.participants.includes(actor) || !(await hasChannelAccess(c, actor, row.workspace_id, id)))
    throw new AppError(404, 'not_found');
  return row;
}
export async function dmDevices(c: DbSession, channel: string) {
  return (
    await c.execute<DmDevice & Record<string, unknown>>(
      sql`SELECT id,user_id,public_key,device_proof AS "authorization",revoked FROM dm_devices WHERE channel_id=${channel} ORDER BY id`,
    )
  ).rows;
}
export class DmEncryptionStore {
  constructor(private db: Database) {}
  state(actor: string, id: string): Promise<DmEncryption> {
    return this.db.transaction(
      async (c) => ({ enabled: (await visible(c, actor, id)).enabled, devices: await dmDevices(c, id) }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  change(actor: string, channel: string, operation: 'enroll' | 'revoke' | 'enable', raw: unknown) {
    return sessionTransaction(this.db, async (c) => {
      const room = await visible(c, actor, channel),
        devices = await dmDevices(c, channel);
      if (operation === 'enroll') {
        const v = record(raw, ['id', 'public_key', 'recovery', 'authorization']),
          id = uuid(v.id),
          key = text(v.public_key, 8192),
          recovery = text(v.recovery, 64);
        const authorization = text(v.authorization, 64);
        if (
          !/^[a-f0-9]{64}$/.test(authorization) ||
          !/^[a-f0-9]{64}$/.test(recovery) ||
          !/^-----BEGIN PGP PUBLIC KEY BLOCK-----\r?\n[\s\S]+\n-----END PGP PUBLIC KEY BLOCK-----\s*$/.test(key)
        )
          throw new AppError(400, 'invalid_device');
        const hash = createHash('sha256').update(recovery).digest('hex');
        await c.execute(
          sql`INSERT INTO dm_device_accounts VALUES(${channel},${actor},${hash}) ON CONFLICT DO NOTHING`,
        );
        const stored = (
          await c.execute<{ recovery_hash: string }>(
            sql`SELECT recovery_hash FROM dm_device_accounts WHERE channel_id=${channel} AND user_id=${actor}`,
          )
        ).rows[0]!;
        if (!timingSafeEqual(Buffer.from(hash), Buffer.from(stored.recovery_hash)))
          throw new AppError(403, 'recovery_code_required');
        const prior = devices.find((d) => d.id === id);
        if (
          prior &&
          (prior.revoked ||
            prior.user_id !== actor ||
            prior.public_key !== key ||
            prior.authorization !== authorization)
        )
          throw new AppError(409, 'device_conflict');
        if (!prior) {
          const mine = devices.filter((d) => d.user_id === actor);
          if (mine.length >= 64 || mine.filter((d) => !d.revoked).length >= 8)
            throw new AppError(409, 'device_limit');
          await c.execute(
            sql`INSERT INTO dm_devices(id,channel_id,user_id,public_key,device_proof) VALUES(${id},${channel},${actor},${key},${authorization})`,
          );
        }
      } else if (operation === 'revoke') {
        const v = record(raw, ['id']);
        if (!devices.some((d) => d.id === v.id && d.user_id === actor)) throw new AppError(404, 'not_found');
        await c.execute(
          sql`UPDATE dm_devices SET revoked=true WHERE channel_id=${channel} AND user_id=${actor} AND id=${uuid(v.id)}`,
        );
      } else {
        const v = record(raw, ['recipients']),
          live = devices.filter((d) => !d.revoked);
        if (
          !Array.isArray(v.recipients) ||
          v.recipients.length !== live.length ||
          live.some((d) => !(v.recipients as unknown[]).includes(d.id))
        )
          throw new AppError(409, 'devices_changed');
        if (room.participants.some((user) => !live.some((d) => d.user_id === user)))
          throw new AppError(409, 'both_participants_must_enroll');
        if (!room.enabled) {
          const held = await c.execute(
            sql`SELECT 1 FROM scheduled_messages WHERE channel_id=${channel} AND status IN ('pending','sending') LIMIT 1`,
          );
          if (held.rows.length) throw new AppError(409, 'cancel_scheduled_messages_first');
          await c.execute(sql`UPDATE channels SET encrypted_since=now() WHERE id=${channel}`);
        }
      }
      await c.execute(
        sql`INSERT INTO chat_delivery_outbox(channel_id,workspace_id,resource_scope) VALUES(${channel},${room.workspace_id},'metadata')`,
      );
      return { ok: true };
    });
  }
}
