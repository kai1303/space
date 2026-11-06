import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import {
  AppError,
  record,
  text,
  uuid,
  parseOutboundConnection,
  parseOutboundTools,
  type OutboundConnection,
  type OutboundTool,
  type OutboundAgent,
  type OutboundCall,
} from '@space/contracts';
import { OutboundSecurity, type OutboundClaims } from './outbound-security.js';
// Leave room for providers' mcp__space_outbound__ prefix within 64 characters.
export const outboundToolName = (id: string, name: string) =>
  `x_${createHash('sha256').update(`${id}:${name}`).digest('hex').slice(0, 24)}_${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16)}`;
type Query = Pick<PoolClient, 'query'>;
const revision = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new AppError(400, 'invalid_revision');
  return value as number;
};
export function fingerprint(value: unknown): string {
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
export class OutboundStore {
  readonly security: OutboundSecurity;
  constructor(
    readonly pool: Pool,
    key: string,
  ) {
    this.security = new OutboundSecurity(key);
  }
  async transaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.pool.connect();
      try {
        await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await work(c);
        await c.query('COMMIT');
        return result;
      } catch (error) {
        await c.query('ROLLBACK');
        if (!['40001', '40P01', '23505'].includes((error as any).code) || attempt >= 15) throw error;
      } finally {
        c.release();
      }
      await delay(Math.min(200, 10 * 2 ** attempt) + Math.random() * 30);
    }
  }
  async get(owner: string, id: string, c: Query = this.pool): Promise<OutboundConnection> {
    const { rows } = await c.query(
      `SELECT c.id,c.name,c.url,c.auth_type,c.enabled,c.revision,c.status,c.tools,c.created_at,
   coalesce((SELECT jsonb_agg(jsonb_build_object('installation_id',g.installation_id,'tools',g.tools) ORDER BY g.installation_id) FROM outbound_grants g WHERE g.connection_id=c.id),'[]') AS grants
   FROM outbound_connections c WHERE c.owner_id=$1 AND c.id=$2`,
      [uuid(owner), uuid(id)],
    );
    if (!rows[0]) throw new AppError(404, 'not_found');
    return { ...rows[0], created_at: rows[0].created_at.toISOString() };
  }
  async list(owner: string) {
    const { rows } = await this.pool.query(
      'SELECT id FROM outbound_connections WHERE owner_id=$1 ORDER BY created_at,id LIMIT 20',
      [uuid(owner)],
    );
    return { items: await Promise.all(rows.map((r) => this.get(owner, r.id))) };
  }
  async create(owner: string, raw: unknown) {
    const input = parseOutboundConnection(raw),
      id = randomUUID();
    return this.transaction(async (c) => {
      const slots = await c.query(
        'SELECT slot FROM generate_series(1,20) slot WHERE NOT EXISTS(SELECT 1 FROM outbound_connections WHERE owner_id=$1 AND outbound_connections.slot=slot.slot) ORDER BY slot LIMIT 1',
        [uuid(owner)],
      );
      if (!slots.rows[0]) throw new AppError(409, 'connection_limit');
      await c.query(
        'INSERT INTO outbound_connections(id,owner_id,slot,name,url,auth_type,secret) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          owner,
          slots.rows[0].slot,
          input.name,
          input.url,
          input.auth_type,
          input.token ? this.security.encrypt(input.token, `${owner}:${id}`) : null,
        ],
      );
      return this.get(owner, id, c);
    });
  }
  async update(owner: string, id: string, raw: unknown) {
    const input = record(raw, ['revision', 'name', 'url', 'auth_type', 'token', 'enabled']),
      rev = revision(input.revision);
    return this.transaction(async (c) => {
      const previous = await this.get(owner, id, c);
      if (previous.revision !== rev) throw new AppError(409, 'connection_changed');
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new AppError(400, 'invalid_enabled');
      const current = await this.credentials(owner, id, c),
        auth = input.auth_type ?? previous.auth_type;
      const parsed = parseOutboundConnection({
        name: input.name ?? previous.name,
        url: input.url ?? previous.url,
        auth_type: auth,
        ...(auth === 'bearer' ? { token: input.token ?? current.token } : {}),
      });
      if (auth === 'none' && input.token !== undefined) throw new AppError(400, 'invalid_mcp_token');
      const reset = parsed.url !== previous.url || parsed.auth_type !== previous.auth_type || input.token !== undefined;
      await c.query(
        `UPDATE outbound_connections SET name=$3,url=$4,auth_type=$5,secret=$6,enabled=$7,revision=revision+1,tools=CASE WHEN $8 THEN '[]'::jsonb ELSE tools END,status=CASE WHEN $8 THEN 'untested' ELSE status END WHERE owner_id=$1 AND id=$2`,
        [
          owner,
          id,
          parsed.name,
          parsed.url,
          parsed.auth_type,
          parsed.token ? this.security.encrypt(parsed.token, `${owner}:${id}`) : null,
          input.enabled ?? previous.enabled,
          reset,
        ],
      );
      if (reset) await c.query('DELETE FROM outbound_grants WHERE connection_id=$1', [id]);
      return this.get(owner, id, c);
    });
  }
  async remove(owner: string, id: string, raw: unknown) {
    const v = record(raw, ['revision']);
    return this.transaction(async (c) => {
      const previous = await this.get(owner, id, c);
      if (previous.revision !== revision(v.revision)) throw new AppError(409, 'connection_changed');
      await c.query('DELETE FROM outbound_connections WHERE id=$1 AND owner_id=$2', [id, owner]);
      return { deleted: true };
    });
  }
  async credentials(owner: string, id: string, c: Query = this.pool): Promise<OutboundConnection & { token?: string }> {
    if (c === this.pool) return this.transaction((client) => this.credentials(owner, id, client));
    const connection = await this.get(owner, id, c),
      { rows } = await c.query('SELECT secret FROM outbound_connections WHERE id=$1 AND owner_id=$2', [id, owner]);
    return {
      ...connection,
      token: rows[0]?.secret ? this.security.decrypt(rows[0].secret, `${owner}:${id}`) : undefined,
    };
  }
  async catalog(owner: string, id: string, rev: number, raw: unknown) {
    const tools = parseOutboundTools(raw);
    return this.transaction(async (c) => {
      const previous = await this.get(owner, id, c);
      if (previous.revision !== revision(rev)) throw new AppError(409, 'connection_changed');
      for (const grant of previous.grants) {
        const retained = grant.tools.filter((name) => {
          const before = previous.tools.find((t) => t.name === name),
            after = tools.find((t) => t.name === name);
          return before && after && fingerprint(before) === fingerprint(after);
        });
        await c.query('UPDATE outbound_grants SET tools=$3 WHERE connection_id=$1 AND installation_id=$2', [
          id,
          grant.installation_id,
          JSON.stringify(retained),
        ]);
      }
      await c.query(
        "UPDATE outbound_connections SET tools=$3,status='ready',revision=revision+1 WHERE owner_id=$1 AND id=$2",
        [owner, id, JSON.stringify(tools)],
      );
      return this.get(owner, id, c);
    });
  }
  async discoveryFailed(owner: string, id: string, rev: number) {
    await this.pool.query(
      "UPDATE outbound_connections SET status='error',revision=revision+1 WHERE owner_id=$1 AND id=$2 AND revision=$3",
      [owner, id, rev],
    );
  }
  async agents(owner: string): Promise<{ items: OutboundAgent[] }> {
    return {
      items: (
        await this.pool.query(
          `SELECT i.id,coalesce(ac.name,d.name) AS name,w.name AS workspace_name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id JOIN workspaces w ON w.id=i.workspace_id JOIN workspace_members m ON m.workspace_id=i.workspace_id AND m.user_id=i.owner_id JOIN agent_connections ac ON ac.installation_id=i.id WHERE i.owner_id=$1 AND i.enabled AND i.connector_id IN ('codex.local','kiro.local','claude.local') AND m.active AND ac.revoked_at IS NULL ORDER BY i.id LIMIT 100`,
          [uuid(owner)],
        )
      ).rows,
    };
  }
  async grant(owner: string, id: string, raw: unknown) {
    const v = record(raw, ['revision', 'installation_id', 'tools']),
      rev = revision(v.revision),
      installation = uuid(v.installation_id);
    if (
      !Array.isArray(v.tools) ||
      v.tools.length > 100 ||
      v.tools.some((t) => typeof t !== 'string') ||
      new Set(v.tools).size !== v.tools.length
    )
      throw new AppError(400, 'invalid_tools');
    const selectedTools = v.tools as string[];
    return this.transaction(async (c) => {
      const connection = await this.get(owner, id, c);
      if (connection.revision !== rev) throw new AppError(409, 'connection_changed');
      if (!selectedTools.every((name) => connection.tools.some((t) => t.name === name)))
        throw new AppError(400, 'unknown_tool');
      const agent = await c.query(
        "SELECT 1 FROM agent_installations i JOIN workspace_members m ON m.workspace_id=i.workspace_id AND m.user_id=i.owner_id JOIN agent_connections ac ON ac.installation_id=i.id WHERE i.id=$1 AND i.owner_id=$2 AND i.enabled AND i.connector_id IN ('codex.local','kiro.local','claude.local') AND m.active AND ac.revoked_at IS NULL",
        [installation, owner],
      );
      if (!agent.rows.length) throw new AppError(404, 'agent_not_owned');
      await c.query(
        'INSERT INTO outbound_grants(connection_id,installation_id,tools) VALUES($1,$2,$3) ON CONFLICT(connection_id,installation_id) DO UPDATE SET tools=excluded.tools',
        [id, installation, JSON.stringify(selectedTools)],
      );
      await c.query('UPDATE outbound_connections SET revision=revision+1 WHERE id=$1', [id]);
      return this.get(owner, id, c);
    });
  }
  async authority(claims: OutboundClaims, c: Query = this.pool) {
    if (claims.exp <= Date.now()) throw new AppError(401, 'unauthorized');
    const result = await c.query(
      `SELECT e.id FROM executions e JOIN tasks t ON t.id=e.task_id JOIN agent_installations i ON i.id=e.installation_id JOIN agent_sessions s ON s.id=e.session_id JOIN workspace_members m ON m.workspace_id=i.workspace_id AND m.user_id=i.owner_id JOIN threads th ON th.id=t.thread_id JOIN channel_members cm ON cm.channel_id=th.channel_id AND cm.workspace_id=i.workspace_id AND cm.user_id=i.owner_id JOIN agent_connections ac ON ac.installation_id=i.id WHERE e.id=$1 AND e.installation_id=$2 AND i.owner_id=$3 AND t.requester_id=$3 AND t.active_execution_id=e.id AND e.status IN ('queued','running') AND t.status IN ('queued','running') AND s.state<>'ended' AND i.enabled AND i.connector_id IN ('codex.local','kiro.local','claude.local') AND m.active AND ac.revoked_at IS NULL`,
      [uuid(claims.execution), uuid(claims.installation), uuid(claims.owner)],
    );
    if (!result.rows.length) throw new AppError(403, 'outbound_access_revoked');
  }
  async allowed(claims: OutboundClaims, c: Query = this.pool) {
    await this.authority(claims, c);
    const { rows } = await c.query(
      `SELECT c.id,c.name AS connection_name,c.revision,c.tools,g.tools AS allowed FROM outbound_connections c JOIN outbound_grants g ON g.connection_id=c.id WHERE c.owner_id=$1 AND g.installation_id=$2 AND c.enabled AND c.status='ready' ORDER BY c.id`,
      [claims.owner, claims.installation],
    );
    return rows.flatMap((r) =>
      (r.tools as OutboundTool[])
        .filter((t) => r.allowed.includes(t.name))
        .map((t) => ({
          ...t,
          name: outboundToolName(r.id, t.name),
          description: `Connection "${r.connection_name}". ${t.description ?? t.name}`,
          upstreamName: t.name,
          connection_id: r.id,
          revision: r.revision,
        })),
    );
  }
  async issue(execution: string, installation: string, url: string) {
    const { rows } = await this.pool.query(
      'SELECT i.owner_id FROM executions e JOIN agent_installations i ON i.id=e.installation_id WHERE e.id=$1 AND i.id=$2',
      [execution, installation],
    );
    if (!rows[0]) return undefined;
    const claims: OutboundClaims = {
      owner: rows[0].owner_id,
      installation,
      execution,
      exp: Date.now() + 150000,
      aud: 'outbound',
    };
    let tools;
    try {
      tools = await this.allowed(claims);
    } catch (e) {
      if (e instanceof AppError && e.code === 'outbound_access_revoked') return undefined;
      throw e;
    }
    return tools.length ? { url, token: this.security.sign(claims), tools: tools.map((t) => t.name) } : undefined;
  }
  async reserve(claims: OutboundClaims, requestId: string, name: string, args: unknown, expectedRevision?: number) {
    text(requestId, 200);
    const hash = fingerprint({ name, args });
    return this.transaction(async (c) => {
      const selected = (await this.allowed(claims, c)).find((t) => t.name === name);
      if (!selected) throw new AppError(403, 'tool_not_allowed');
      if (expectedRevision !== undefined && selected.revision !== expectedRevision)
        throw new AppError(409, 'connection_changed');
      const existing = (
        await c.query(
          'SELECT fingerprint,status,deadline FROM outbound_calls WHERE execution_id=$1 AND request_id=$2',
          [claims.execution, requestId],
        )
      ).rows[0];
      if (existing)
        throw new AppError(
          409,
          existing.fingerprint !== hash
            ? 'call_identity_conflict'
            : existing.status === 'pending' && existing.deadline.getTime() > Date.now()
              ? 'call_in_progress'
              : 'call_already_dispatched',
        );
      const { rows } = await c.query(
        "SELECT count(*)::int AS count FROM outbound_calls WHERE owner_id=$1 AND status='pending' AND deadline>now()",
        [claims.owner],
      );
      if (rows[0].count >= 4) throw new AppError(429, 'outbound_busy');
      const connection = await this.credentials(claims.owner, selected.connection_id, c);
      const agent = (
        await c.query(
          'SELECT coalesce(ac.name,d.name) AS name FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id JOIN agent_connections ac ON ac.installation_id=i.id WHERE i.id=$1',
          [claims.installation],
        )
      ).rows[0];
      const id = randomUUID();
      await c.query(
        `INSERT INTO outbound_calls(id,owner_id,execution_id,request_id,fingerprint,connection_id,connection_name,tool_name,installation_id,agent_name,deadline,retain_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '30 seconds',$11)`,
        [
          id,
          claims.owner,
          claims.execution,
          requestId,
          hash,
          connection.id,
          connection.name,
          selected.upstreamName,
          claims.installation,
          agent.name,
          new Date(claims.exp + 30000),
        ],
      );
      return { id, connection, tool: selected };
    });
  }
  async finish(id: string, status: 'succeeded' | 'failed' | 'uncertain', duration: number) {
    await this.pool.query("UPDATE outbound_calls SET status=$2,duration_ms=$3 WHERE id=$1 AND status='pending'", [
      id,
      status,
      Math.max(0, Math.round(duration)),
    ]);
    await this.pool.query(
      `DELETE FROM outbound_calls WHERE owner_id=(SELECT owner_id FROM outbound_calls WHERE id=$1) AND retain_until<now() AND NOT EXISTS(SELECT 1 FROM executions e WHERE e.id=outbound_calls.execution_id AND e.status IN ('queued','running')) AND id IN (SELECT id FROM outbound_calls WHERE owner_id=(SELECT owner_id FROM outbound_calls WHERE id=$1) ORDER BY created_at DESC,id OFFSET 1000)`,
      [id],
    );
  }
  async calls(owner: string, before?: unknown): Promise<{ items: OutboundCall[]; next_cursor?: string }> {
    const cursor = before === undefined ? null : uuid(before);
    if (
      cursor &&
      !(await this.pool.query('SELECT 1 FROM outbound_calls WHERE owner_id=$1 AND id=$2', [uuid(owner), cursor])).rows
        .length
    )
      throw new AppError(404, 'not_found');
    const { rows } = await this.pool.query(
      `SELECT id,connection_name,tool_name,agent_name,CASE WHEN status='pending' AND deadline<=now() THEN 'uncertain' ELSE status END AS status,created_at,duration_ms FROM outbound_calls WHERE owner_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM outbound_calls WHERE owner_id=$1 AND id=$2)) ORDER BY created_at DESC,id DESC LIMIT 101`,
      [uuid(owner), cursor],
    );
    return {
      items: rows.slice(0, 100).map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
      ...(rows.length > 100 ? { next_cursor: rows[99].id } : {}),
    };
  }
}
