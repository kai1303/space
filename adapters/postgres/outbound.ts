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
export type OutboundScope = string | { actor: string; workspace: string };

function scopeKey(scope: OutboundScope) {
  return typeof scope === 'string'
    ? { column: 'owner_id' as const, id: uuid(scope) }
    : { column: 'workspace_id' as const, id: uuid(scope.workspace) };
}

function connectionBinding(owner: string | null, workspace: string | null, id: string) {
  return workspace ? `workspace:${uuid(workspace)}:${uuid(id)}` : `${uuid(owner)}:${uuid(id)}`;
}
function managedBinding(scope: OutboundScope, id: string) {
  return typeof scope === 'string' ? connectionBinding(scope, null, id) : connectionBinding(null, scope.workspace, id);
}
async function requireManager(c: Query, scope: OutboundScope) {
  if (typeof scope === 'string') return;
  const { rows } = await c.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active',
    [uuid(scope.workspace), uuid(scope.actor)]);
  if (!rows.length) throw new AppError(404, 'not_found');
  if (!['owner', 'admin'].includes(rows[0].role)) throw new AppError(403, 'workspace_management_forbidden');
}

const agentTables = `FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id
  JOIN workspaces w ON w.id=i.workspace_id JOIN workspace_members m ON m.workspace_id=i.workspace_id AND m.user_id=i.owner_id
  LEFT JOIN agent_connections ac ON ac.installation_id=i.id`;
const canGrant = `i.enabled AND i.connector_id IN ('codex.local','kiro.local','claude.local')
  AND m.active AND ac.installation_id IS NOT NULL AND ac.revoked_at IS NULL`;

function agentPage(scope: OutboundScope) {
  // Keep grantees visible while disabled or offboarded so admins can revoke access.
  const visible = typeof scope === 'string' ? canGrant : `(${canGrant}) OR EXISTS (
    SELECT 1 FROM outbound_grants saved JOIN outbound_connections server ON server.id=saved.connection_id
    WHERE saved.installation_id=i.id AND server.workspace_id=$1 AND saved.tools<>'[]'::jsonb)`;
  return `${agentTables} WHERE (${visible}) AND i.${scopeKey(scope).column}=$1
          AND ($2::uuid IS NULL OR i.id>$2) ORDER BY i.id`;
}

async function readAgentPage(c: Query, scope: OutboundScope, after?: unknown): Promise<{ items: OutboundAgent[]; next_cursor?: string }> {
  const { rows } = await c.query(
    `SELECT i.id,coalesce(ac.name,d.name) AS name,w.name AS workspace_name
      ${typeof scope === 'string' ? '' : `, (${canGrant}) AS can_grant`} ${agentPage(scope)} LIMIT 101`,
    [scopeKey(scope).id, after === undefined ? null : uuid(after)],
  );
  return { items: rows.slice(0, 100), ...(rows.length > 100 ? { next_cursor: rows[99].id } : {}) };
}

function connectionSelect(scope: OutboundScope) {
  const workspace = typeof scope !== 'string';
  const visibleGrants = workspace ? `AND g.installation_id IN (SELECT i.id ${agentPage(scope)} LIMIT 100)` : '';
  return `SELECT c.id,c.kind,c.name,c.url,c.auth_type,c.enabled,c.revision,c.status,c.tools,c.created_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object('installation_id',g.installation_id,'tools',g.tools) ORDER BY g.installation_id)
      FROM outbound_grants g WHERE g.connection_id=c.id ${visibleGrants}),'[]') AS grants
    FROM outbound_connections c WHERE c.${scopeKey(scope).column}=$1`;
}
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
  async get(scope: OutboundScope, id: string, c: Query = this.pool): Promise<OutboundConnection> {
    if (typeof scope !== 'string' && c === this.pool) return this.transaction(client => this.get(scope, id, client));
    await requireManager(c, scope);
    const key = scopeKey(scope);
    const params = typeof scope === 'string' ? [key.id, uuid(id)] : [key.id, null, uuid(id)];
    const { rows } = await c.query(`${connectionSelect(scope)} AND c.id=$${params.length}`, params);
    if (!rows[0]) throw new AppError(404, 'not_found');
    return { ...rows[0], created_at: rows[0].created_at.toISOString() };
  }
  async list(scope: OutboundScope, after?: unknown) {
    const key = scopeKey(scope);
    return this.transaction(async c => {
      await requireManager(c, scope);
      const params = typeof scope === 'string' ? [key.id] : [key.id, after === undefined ? null : uuid(after)];
      const { rows } = await c.query(`${connectionSelect(scope)} ORDER BY c.created_at,c.id LIMIT 20`, params);
      const items: OutboundConnection[] = rows.map(row => ({ ...row, created_at: row.created_at.toISOString() }));
      return typeof scope === 'string' ? { items } : { items, agents: await readAgentPage(c, scope, after) };
    });
  }
  async create(scope: OutboundScope, raw: unknown) {
    const key = scopeKey(scope);
    const input = parseOutboundConnection(raw),
      id = randomUUID();
    if (input.kind !== 'mcp' && typeof scope === 'string') throw new AppError(400, 'workspace_plugin_required');
    return this.transaction(async (c) => {
      await requireManager(c, scope);
      const slots = await c.query(
        `SELECT slot FROM generate_series(1,20) slot WHERE NOT EXISTS(SELECT 1 FROM outbound_connections WHERE ${key.column}=$1 AND outbound_connections.slot=slot.slot) ORDER BY slot LIMIT 1`,
        [key.id],
      );
      if (!slots.rows[0]) throw new AppError(409, 'connection_limit');
      await c.query(
        `INSERT INTO outbound_connections(id,${key.column},slot,name,url,auth_type,secret,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          key.id,
          slots.rows[0].slot,
          input.name,
          input.url,
          input.auth_type,
          input.token ? this.security.encrypt(input.token, managedBinding(scope, id)) : null,
          input.kind,
        ],
      );
      return this.get(scope, id, c);
    });
  }
  async update(scope: OutboundScope, id: string, raw: unknown) {
    const input = record(raw, ['revision', 'name', 'url', 'auth_type', 'token', 'enabled']),
      rev = revision(input.revision);
    return this.transaction(async (c) => {
      const previous = await this.get(scope, id, c);
      if (previous.revision !== rev) throw new AppError(409, 'connection_changed');
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new AppError(400, 'invalid_enabled');
      const current = await this.credentials(scope, id, c),
        auth = input.auth_type ?? previous.auth_type;
      const parsed = parseOutboundConnection({
        kind: previous.kind,
        name: input.name ?? previous.name,
        url: input.url ?? previous.url,
        auth_type: auth,
        ...(auth === 'bearer' ? { token: input.token ?? current.token } : {}),
      });
      if (auth === 'none' && input.token !== undefined) throw new AppError(400, 'invalid_mcp_token');
      if (typeof scope !== 'string' && parsed.url !== previous.url && auth === 'bearer' && !input.token)
        throw new AppError(400, 'invalid_mcp_token');
      const reset = parsed.url !== previous.url || parsed.auth_type !== previous.auth_type || input.token !== undefined;
      await c.query(
        `UPDATE outbound_connections SET name=$2,url=$3,auth_type=$4,secret=$5,enabled=$6,revision=revision+1,
         credential_revision=credential_revision + CASE WHEN $7 OR enabled IS DISTINCT FROM $6 THEN 1 ELSE 0 END,
         tools=CASE WHEN $7 THEN '[]'::jsonb ELSE tools END,status=CASE WHEN $7 THEN 'untested' ELSE status END WHERE id=$1`,
        [
          id,
          parsed.name,
          parsed.url,
          parsed.auth_type,
          parsed.token ? this.security.encrypt(parsed.token, managedBinding(scope, id)) : null,
          input.enabled ?? previous.enabled,
          reset,
        ],
      );
      if (reset) await c.query('DELETE FROM outbound_grants WHERE connection_id=$1', [id]);
      return this.get(scope, id, c);
    });
  }
  async remove(scope: OutboundScope, id: string, raw: unknown) {
    const v = record(raw, ['revision']);
    return this.transaction(async (c) => {
      const previous = await this.get(scope, id, c);
      if (previous.revision !== revision(v.revision)) throw new AppError(409, 'connection_changed');
      await c.query('DELETE FROM outbound_connections WHERE id=$1', [id]);
      return { deleted: true };
    });
  }
  async credentials(scope: OutboundScope, id: string, c: Query = this.pool): Promise<OutboundConnection & { token?: string }> {
    if (c === this.pool) return this.transaction((client) => this.credentials(scope, id, client));
    const connection = await this.get(scope, id, c),
      { rows } = await c.query('SELECT secret FROM outbound_connections WHERE id=$1', [id]);
    return {
      ...connection,
      token: rows[0]?.secret ? this.security.decrypt(rows[0].secret, managedBinding(scope, id)) : undefined,
    };
  }
  async catalog(scope: OutboundScope, id: string, rev: number, raw: unknown) {
    const tools = parseOutboundTools(raw);
    return this.transaction(async (c) => {
      const previous = await this.get(scope, id, c);
      if (previous.revision !== revision(rev)) throw new AppError(409, 'connection_changed');
      const retained = tools.filter(tool => {
        const before = previous.tools.find(old => old.name === tool.name);
        return before && fingerprint(before) === fingerprint(tool);
      }).map(tool => tool.name);
      // Reconcile every grant, including agents outside the current UI page.
      await c.query(
        `UPDATE outbound_grants SET tools=coalesce((SELECT jsonb_agg(name ORDER BY ord)
           FROM jsonb_array_elements_text(tools) WITH ORDINALITY AS granted(name, ord)
           WHERE name=ANY($2::text[])), '[]'::jsonb)
         WHERE connection_id=$1 AND NOT tools <@ to_jsonb($2::text[])`,
        [id, retained],
      );
      await c.query(
        "UPDATE outbound_connections SET tools=$2,status='ready',revision=revision+1 WHERE id=$1",
        [id, JSON.stringify(tools)],
      );
      return this.get(scope, id, c);
    });
  }
  async discoveryFailed(scope: OutboundScope, id: string, rev: number) {
    const key = scopeKey(scope);
    await this.transaction(async c => {
      await requireManager(c, scope);
      await c.query(
        `UPDATE outbound_connections SET status='error',revision=revision+1 WHERE ${key.column}=$1 AND id=$2 AND revision=$3`,
        [key.id, uuid(id), rev],
      );
    });
  }
  async agents(scope: OutboundScope, after?: unknown) {
    return this.transaction(async c => {
      await requireManager(c, scope);
      return readAgentPage(c, scope, after);
    });
  }
  async grant(scope: OutboundScope, id: string, raw: unknown) {
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
      const connection = await this.get(scope, id, c);
      if (connection.revision !== rev) throw new AppError(409, 'connection_changed');
      if (!selectedTools.every((name) => connection.tools.some((t) => t.name === name)))
        throw new AppError(400, 'unknown_tool');
      const key = scopeKey(scope);
      const eligible = await c.query(`SELECT 1 ${agentTables} WHERE ${canGrant} AND i.id=$1 AND i.${key.column}=$2`, [installation, key.id]);
      if (!eligible.rowCount) {
        if (typeof scope === 'string') throw new AppError(404, 'agent_not_owned');
        const existing = await c.query(
          `SELECT 1 FROM outbound_grants g JOIN agent_installations i ON i.id=g.installation_id
           WHERE i.workspace_id=$1 AND g.connection_id=$2 AND i.id=$3 AND g.tools<>'[]'::jsonb AND g.tools @> $4::jsonb`,
          [key.id, id, installation, JSON.stringify(selectedTools)],
        );
        if (!existing.rowCount) throw new AppError(404, 'agent_not_available');
      }
      if (typeof scope !== 'string' && !selectedTools.length) {
        await c.query('DELETE FROM outbound_grants WHERE connection_id=$1 AND installation_id=$2', [id, installation]);
      } else {
        await c.query(
          'INSERT INTO outbound_grants(connection_id,installation_id,tools) VALUES($1,$2,$3) ON CONFLICT(connection_id,installation_id) DO UPDATE SET tools=excluded.tools',
          [id, installation, JSON.stringify(selectedTools)],
        );
      }
      await c.query('UPDATE outbound_connections SET revision=revision+1 WHERE id=$1', [id]);
      return this.get(scope, id, c);
    });
  }
  async authority(claims: OutboundClaims, c: Query = this.pool) {
    if (claims.exp <= Date.now()) throw new AppError(401, 'unauthorized');
    const result = await c.query(
      `SELECT e.id,i.workspace_id,th.channel_id, (s.handoff_context ? 'browser_url') IS TRUE AS personal_only FROM executions e
       JOIN tasks t ON t.id=e.task_id AND t.active_execution_id=e.id AND t.installation_id=e.installation_id AND t.session_id=e.session_id
       JOIN agent_installations i ON i.id=e.installation_id
       JOIN agent_sessions s ON s.id=e.session_id AND s.installation_id=i.id
       JOIN agent_connections ac ON ac.installation_id=i.id AND ac.revoked_at IS NULL
       JOIN threads th ON th.id=t.thread_id
       JOIN workspace_members owner ON owner.workspace_id=i.workspace_id AND owner.user_id=i.owner_id AND owner.active
       JOIN workspace_members requester ON requester.workspace_id=i.workspace_id AND requester.user_id=t.requester_id AND requester.active
       JOIN channel_members oc ON oc.channel_id=th.channel_id AND oc.user_id=i.owner_id
       JOIN channel_members rc ON rc.channel_id=th.channel_id AND rc.user_id=t.requester_id
       WHERE e.id=$1 AND i.id=$2 AND i.owner_id=$3 AND t.requester_id=$4 AND ($5::uuid IS NULL OR i.workspace_id=$5)
       AND e.status IN ('queued','running') AND t.status IN ('queued','running') AND s.state<>'ended'
       AND i.enabled AND i.connector_id IN ('codex.local','kiro.local','claude.local')`,
      [
        uuid(claims.execution),
        uuid(claims.installation),
        uuid(claims.owner),
        uuid(claims.requester ?? claims.owner),
        claims.workspace === undefined ? null : uuid(claims.workspace),
      ],
    );
    if (!result.rows.length) throw new AppError(403, 'outbound_access_revoked');
    return { personalOnly: result.rows[0].personal_only === true, workspaceId: String(result.rows[0].workspace_id), channelId: String(result.rows[0].channel_id) };
  }
  async allowed(claims: OutboundClaims, c: Query = this.pool) {
    const authority = await this.authority(claims, c);
    const { rows } = await c.query(
      `SELECT c.id,c.kind,c.url,c.name AS connection_name,c.workspace_id,c.revision,c.credential_revision,c.tools,g.tools AS allowed
       FROM outbound_connections c JOIN outbound_grants g ON g.connection_id=c.id
       WHERE ((c.owner_id=$1 AND c.owner_id=$3) OR c.workspace_id=$4) AND g.installation_id=$2
       AND c.enabled AND c.status='ready' ORDER BY c.id`,
      [claims.owner, claims.installation, claims.requester ?? claims.owner, authority.personalOnly ? null : claims.workspace ?? null],
    );
    return rows.flatMap((r) =>
      (r.tools as OutboundTool[])
        .filter((t) => r.allowed.includes(t.name))
        .map((t) => ({
          ...t,
          name: outboundToolName(r.id, t.name),
          description: `${r.workspace_id ? 'Workspace connection' : 'Connection'} "${r.connection_name}". ${t.description ?? t.name}`,
          upstreamName: t.name,
          url: r.url as string,
          kind: r.kind as import('@space/contracts').ConnectionKind,
          definition: t,
          connection_id: r.id,
          revision: r.revision as number,
          credentialRevision: r.workspace_id ? r.credential_revision as number : undefined,
        })),
    );
  }
  async allowedTool(claims: OutboundClaims, name: string, c: Query = this.pool) {
    const selected = (await this.allowed(claims, c)).find((tool) => tool.name === name);
    if (!selected) return undefined;
    // A different installation's grant edit does not invalidate this workspace tool.
    const dispatchRevision = selected.credentialRevision === undefined
      ? selected.revision
      : fingerprint([selected.credentialRevision, selected.definition]);
    return { ...selected, dispatchRevision };
  }
  async issue(execution: string, installation: string, url: string) {
    const { rows } = await this.pool.query(
      `SELECT i.owner_id,i.workspace_id,t.requester_id FROM executions e
       JOIN agent_installations i ON i.id=e.installation_id JOIN tasks t ON t.id=e.task_id WHERE e.id=$1 AND i.id=$2`,
      [execution, installation],
    );
    if (!rows[0]) return undefined;
    const claims: OutboundClaims = {
      owner: rows[0].owner_id,
      requester: rows[0].requester_id,
      workspace: rows[0].workspace_id,
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
  async reserve(claims: OutboundClaims, requestId: string, name: string, args: unknown, expectedRevision?: number | string) {
    text(requestId, 200);
    const hash = fingerprint({ name, args });
    return this.transaction(async (c) => {
      const selected = await this.allowedTool(claims, name, c);
      if (!selected) throw new AppError(403, 'tool_not_allowed');
      if (expectedRevision !== undefined && selected.dispatchRevision !== expectedRevision)
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
      const requester = claims.requester ?? claims.owner;
      const { rows } = await c.query(
        "SELECT count(*)::int AS count FROM outbound_calls WHERE owner_id=$1 AND status='pending' AND deadline>now()",
        [requester],
      );
      if (rows[0].count >= 4) throw new AppError(429, 'outbound_busy');
      // Only decrypt the selected grant, in the snapshot that authorized its dispatch.
      const { rows: [endpoint] } = await c.query(
        'SELECT id,kind,name,url,secret,owner_id,workspace_id FROM outbound_connections WHERE id=$1',
        [selected.connection_id],
      );
      const connection = {
        id: selected.connection_id,
        kind: endpoint.kind as import('@space/contracts').ConnectionKind,
        name: endpoint.name as string,
        url: endpoint.url as string,
        token: endpoint.secret
          ? this.security.decrypt(endpoint.secret, connectionBinding(endpoint.owner_id, endpoint.workspace_id, endpoint.id))
          : undefined,
      };
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
          requester,
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
