import { isDeepStrictEqual } from 'node:util';
import { sql, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { ScheduledMessageStore } from './scheduled-messages.js';
import type { ChatStore } from './chat.js';
import { AppError, record, uuid, parseEncryptedDm, parseComposerDraftKey, parseComposerDraftMutation, type AssetAttachment, type ComposerDraftPage, type ComposerDraftRow, type ComposerDraftValue } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { sessionTransaction } from './session-concurrency.js';

const pageSize = 32;
const conflict = () => new AppError(409, 'draft_conflict');
const memberships = sql`JOIN channel_members cm ON cm.channel_id=ch.id AND cm.workspace_id=ch.workspace_id
  JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id AND wm.active
  LEFT JOIN users peer ON peer.id=CASE WHEN ch.direct_user_low=cm.user_id THEN ch.direct_user_high ELSE ch.direct_user_low END`;
const destinationName = sql`CASE WHEN ch.kind='channel' THEN ch.name WHEN ch.direct_user_low=ch.direct_user_high THEN peer.display_name||' (you)' ELSE peer.display_name END`;

function visibleThread(channel: SQL, thread: SQL, actor: string) {
  return sql`EXISTS (SELECT 1 FROM threads t WHERE t.channel_id=${channel} AND t.id=${thread}
    AND NOT EXISTS (SELECT 1 FROM agent_sessions a WHERE a.origin_thread_id=t.id AND a.handoff_context IS NOT NULL
      AND a.created_by IS DISTINCT FROM ${actor}::uuid))`;
}

async function requireDestination(c: DbSession, actor: string, { channel, thread, encrypted }: ReturnType<typeof parseComposerDraftKey>) {
  const { rows: [room] } = await c.execute<{workspace_id: string; encrypted: boolean; destination_name: string}>(sql`
    SELECT ch.workspace_id,${destinationName} AS destination_name,ch.encrypted_since IS NOT NULL AS encrypted FROM channels ch ${memberships}
    WHERE ch.id=${channel} AND cm.user_id=${actor}
      ${thread ? sql`AND ${visibleThread(sql`ch.id`, sql`${thread}::uuid`, actor)}` : sql``}`);
  if (!room) throw new AppError(404, 'not_found');
  if (room.encrypted !== encrypted) throw new AppError(409, 'dm_encryption_mode_changed');
  return room;
}

function draftAssetIds(value: ComposerDraftValue) {
  if (!value) return [];
  return 'files' in value ? value.files.map(file => file.id) : value.asset_ids ?? [];
}

async function checkNewFiles(c: DbSession, actor: string, channel: string, value: ComposerDraftValue, previous: ComposerDraftValue) {
  if (!value) return;
  const oldIds = new Set(draftAssetIds(previous));
  const previousFiles = previous && 'files' in previous ? previous.files : [];
  // Existing expired references must not block updating the text or removing another file.
  const added = 'files' in value ? value.files.filter(file => !previousFiles.some(old =>
    old.id === file.id && old.name === file.name && old.type === file.type && old.size === file.size)).map(file => file.id)
    : (value.asset_ids ?? []).filter(id => !oldIds.has(id));
  if (!added.length) return;
  const result = await c.execute<AssetAttachment>(sql`SELECT id,name,type,size FROM assets
    WHERE id=ANY(${sql.param(added)}::uuid[]) AND uploader_id=${actor} AND channel_id=${channel}
      AND status='ready' AND encrypted=${'ciphertext' in value} AND message_id IS NULL AND task_id IS NULL
      AND queue_input_id IS NULL AND expires_at>now()`);
  if (result.rows.length !== added.length || ('files' in value && result.rows.some(row =>
    !value.files.some(file => file.id === row.id && file.name === row.name && file.type === row.type && file.size === row.size)))) {
    throw new AppError(409, 'asset_unavailable');
  }
}

export class ComposerDraftStore {
  readonly db;
  constructor(pool: Pool) { this.db = database(pool); }

  async list(actor: string, after?: unknown): Promise<ComposerDraftPage> {
    const cursor = after === undefined ? '' : parseComposerDraftKey(after).key;
    const { rows } = await this.db.execute<ComposerDraftRow & Record<string, unknown>>(sql`
      SELECT d.workspace_id,${destinationName} AS destination_name,d.key,d.revision,d.value FROM composer_drafts d JOIN channels ch ON ch.id=d.channel_id
      ${memberships} WHERE d.actor_id=${actor} AND cm.user_id=d.actor_id
        AND d.value IS NOT NULL AND d.key>${cursor} AND (ch.encrypted_since IS NOT NULL)=(d.key='encrypted:'||ch.id)
        AND (d.thread_id IS NULL OR ${visibleThread(sql`d.channel_id`, sql`d.thread_id`, actor)})
      ORDER BY d.key LIMIT ${pageSize + 1}`);
    const items = rows.slice(0, pageSize);
    return { items, next: rows.length > pageSize ? items[pageSize - 1]!.key : null };
  }

  get(actor: string, rawKey: string) {
    const destination = parseComposerDraftKey(rawKey);
    return this.db.transaction(async c => {
      const room = await requireDestination(c, actor, destination);
      const { rows: [row] } = await c.execute<Pick<ComposerDraftRow, 'key' | 'revision' | 'value'>>(sql`
        SELECT key,revision,value FROM composer_drafts WHERE actor_id=${actor} AND key=${destination.key}`);
      return { workspace_id: room.workspace_id, destination_name: room.destination_name, ...(row ?? { key: destination.key, revision: null, value: null }) };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async submit(action: {send: ChatStore} | {schedule: ScheduledMessageStore}, actor: string, rawKey: string, body: unknown) {
    const target = parseComposerDraftKey(rawKey);
    const scheduling = 'schedule' in action;
    if (scheduling && target.encrypted) throw new AppError(409, 'encrypted_scheduling_unavailable');
    const args = record(body, scheduling ? ['revision', 'send_at'] : target.encrypted ? ['revision', 'encrypted'] : ['revision', 'broadcast_confirmed']);
    const revision = uuid(args.revision);
    if (scheduling && (typeof args.send_at !== 'string' || args.send_at.length > 40 || !Number.isFinite(Date.parse(args.send_at))))
      throw new AppError(400, 'invalid_send_at');
    const sendAt = scheduling ? new Date(args.send_at as string).toISOString() : undefined;
    const envelope = target.encrypted ? parseEncryptedDm(args.encrypted) : undefined;
    return sessionTransaction(this.db, async c => {
      const room = await requireDestination(c, actor, target);
      const { rows: [draft] } = await c.execute<Pick<ComposerDraftRow, 'revision' | 'value'>>(sql`
        SELECT revision,value FROM composer_drafts WHERE actor_id=${actor} AND key=${target.key}`);
      if (draft?.revision !== revision || !draft.value) {
        // Two devices can send the same revision, or a successful response can be lost.
        const sent = scheduling ? await c.execute(sql`SELECT 1 FROM scheduled_messages WHERE id=${revision}
          AND user_id=${actor} AND channel_id=${target.channel} AND thread_id IS NOT DISTINCT FROM ${target.thread}::uuid
          AND send_at=${sendAt}::timestamptz`) : await c.execute(sql`SELECT 1 FROM message_identities WHERE workspace_id=${room.workspace_id}
          AND user_id=${actor} AND channel_id=${target.channel} AND client_message_id=${revision}`);
        if (sent.rowCount) return;
        throw conflict();
      }
      if (scheduling && Date.parse(sendAt!) < Math.floor(Date.now() / 60000) * 60000 + 5 * 60000)
        throw new AppError(400, 'draft_schedule_too_soon');
      const value = draft.value;
      let content;
      if ('ciphertext' in value) {
        if (!envelope || !isDeepStrictEqual(envelope.asset_ids ?? [], value.asset_ids ?? [])) throw new AppError(400, 'invalid_encrypted_draft');
        content = { encrypted: envelope };
      } else {
        const {document, files} = value;
        content = {
          text: document.ops.map(op => op.insert).join('').trim(),
          ...(document.ops.length && {document}),
          asset_ids: files.map(file => file.id),
          asset_descriptions: Object.fromEntries(files.filter(file => file.description).map(file => [file.id, file.description])),
          ...(target.thread && {thread_id: target.thread}),

        };
      }
      if (scheduling) {
        await action.schedule.scheduleInTransaction(c, actor, target.channel, {id:revision, send_at:sendAt, ...content});
      } else {
        await action.send.sendInTransaction(c, actor, target.channel, {client_message_id:revision, ...content,
          ...(args.broadcast_confirmed !== undefined && {broadcast_confirmed:args.broadcast_confirmed})});
      }
      const cleared = await c.execute(sql`UPDATE composer_drafts SET value=NULL,asset_ids='{}',base=${revision},revision=gen_random_uuid()
        WHERE actor_id=${actor} AND key=${target.key} AND revision=${revision} RETURNING key`);
      if (!cleared.rowCount) throw conflict();
    });
  }

  put(actor: string, rawKey: string, raw: unknown): Promise<ComposerDraftRow> {
    const destination = parseComposerDraftKey(rawKey);
    const { key, channel, thread, encrypted } = destination;
    const { base, mutation_id, value } = parseComposerDraftMutation(raw, encrypted);
    return sessionTransaction(this.db, async c => {
      const room = await requireDestination(c, actor, destination);
      const row = { workspace_id: room.workspace_id, destination_name: room.destination_name, key, revision: mutation_id, value };
      const target = sql`actor_id=${actor} AND key=${key}`;
      const { rows: [current] } = await c.execute<Pick<ComposerDraftRow, 'revision' | 'value'> & {base: string | null}>(sql`
        SELECT key,revision,base,value FROM composer_drafts WHERE ${target}`);
      if (current?.revision === mutation_id) {
        if (current.base !== base || !isDeepStrictEqual(current.value, value)) throw conflict();
        return row;
      }
      if ((current?.revision ?? null) !== base) throw conflict();
      await checkNewFiles(c, actor, channel, value, current?.value ?? null);
      const assetIds = sql`${sql.param(draftAssetIds(value))}::uuid[]`;
      const payload = value === null ? null : JSON.stringify(value);
      const saved = current
        ? await c.execute(sql`UPDATE composer_drafts SET revision=${mutation_id},base=${base},value=${payload}::jsonb,asset_ids=${assetIds}
            WHERE ${target} AND revision=${base} RETURNING key`)
        : await c.execute(sql`INSERT INTO composer_drafts(actor_id,workspace_id,channel_id,thread_id,key,revision,value,asset_ids)
            VALUES(${actor},${room.workspace_id},${channel},${thread},${key},${mutation_id},${payload}::jsonb,${assetIds})
            ON CONFLICT (actor_id,key) DO NOTHING RETURNING key`);
      if (!saved.rowCount) throw conflict();
      return row;
    });
  }
}
