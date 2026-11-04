import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AppError, invitationToken, parseInvitationInput, parseInvitationQuery, record, uuid, type WorkspaceInvitation, type InvitationResult, type InvitationPreview, type InvitationAcceptance } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { sessionTransaction } from './session-concurrency.js';
import { requireWorkspacePolicy, joinDefaultChannels } from './workspace-settings.js';

type Row = WorkspaceInvitation & { token_hash: string; request_hash: string; revoked_at: Date | null; expires_in_days: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new AppError(404, 'invitation_unavailable');
const columns = sql`id, workspace_id, kind, email, role, guest_type, channel_ids, created_by, created_at, expires_at,
 use_limit, use_count, version, delivery_status, revoked_at, token_hash, request_hash, expires_in_days,
 CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN use_count>=use_limit THEN 'accepted' WHEN expires_at<=now() THEN 'expired' ELSE 'pending' END AS status`;
function dto(row: Row): WorkspaceInvitation {
  return { id: row.id, workspace_id: row.workspace_id, kind: row.kind, email: row.email, role: row.role, guest_type: row.guest_type,
    channel_ids: row.channel_ids, created_by: row.created_by, created_at: new Date(row.created_at).toISOString(), expires_at: new Date(row.expires_at).toISOString(),
    use_limit: row.use_limit, use_count: row.use_count, version: row.version, delivery_status: row.delivery_status, status: row.status };
}
export class WorkspaceInvitationStore {
  readonly db;
  constructor(readonly pool: Pool, readonly options: { emailEncryptionKey?: string } = {}) {
    this.db = database(pool);
    if (options.emailEncryptionKey && !/^[a-f0-9]{64}$/i.test(options.emailEncryptionKey)) throw new Error('SPACE_INVITATION_ENCRYPTION_KEY must be 64 hex characters');
  }
  get emailAvailable() { return !!this.options.emailEncryptionKey; }
  private async actor(c: DbSession, actor: string, workspace: string) {
    const row = (await c.execute(sql`SELECT role,guest_type FROM workspace_members WHERE workspace_id=${uuid(workspace)} AND user_id=${uuid(actor)} AND active`)).rows[0] as { role: 'owner'|'admin'|'member'; guest_type: string } | undefined;
    if (!row) throw new AppError(404, 'not_found');
    if (row.guest_type !== 'none') throw new AppError(403, 'invitation_forbidden');
    return row;
  }
  private async authorize(c: DbSession, actor: string, workspace: string, role: string, guest: string) {
    const member = await this.actor(c, actor, workspace);
    await requireWorkspacePolicy(c, actor, workspace, 'invite');
    if (role === 'admin' && member.role !== 'owner' || guest !== 'none' && member.role === 'member') throw new AppError(403, 'invitation_forbidden');
    return member;
  }
  private async channels(c: DbSession, actor: string, workspace: string, ids: string[]) {
    if (!ids.length) return;
    const found = (await c.execute(sql`SELECT id FROM channels WHERE workspace_id=${workspace} AND id=ANY(${sql.param(ids)}::uuid[]) AND kind='channel' AND archived_at IS NULL
      AND (NOT private OR EXISTS(SELECT 1 FROM channel_members WHERE channel_id=channels.id AND user_id=${actor}))`)).rows;
    if (found.length !== ids.length) throw new AppError(403, 'invitation_channel_forbidden');
  }
  private async audit(c: DbSession, actor: string, row: Row, type: string) {
    await c.execute(sql`INSERT INTO workspace_events(id,workspace_id,actor_id,type,payload) VALUES(${randomUUID()},${row.workspace_id},${actor},${type},${JSON.stringify({invitation_id:row.id,kind:row.kind,role:row.role,guest_type:row.guest_type,version:row.version})}::jsonb)`);
  }
  private async queueEmail(c: DbSession, row: Row, token: string) {
    if (row.kind !== 'email' || !this.options.emailEncryptionKey) return;
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(this.options.emailEncryptionKey, 'hex'), nonce);
    cipher.setAAD(Buffer.from(`${row.id}:${row.version}`));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
    await c.execute(sql`INSERT INTO workspace_invitation_emails(id,workspace_id,invitation_id,version,token_ciphertext) VALUES(${randomUUID()},${row.workspace_id},${row.id},${row.version},${payload})`);
  }
  async list(actor: string, workspace: string, input: unknown = {}) {
    const query = parseInvitationQuery(input);
    return sessionTransaction(this.db, async c => {
      const member = await this.actor(c, actor, workspace);
      if (member.role === 'member') await requireWorkspacePolicy(c, actor, workspace, 'invite');
      const result = (await c.execute(sql`SELECT * FROM (SELECT ${columns} FROM workspace_invitations WHERE workspace_id=${workspace}
        AND kind=${query.kind} ${member.role === 'member' ? sql`AND created_by=${actor}` : sql``}) invitations
        WHERE (${query.status}='all' OR status=${query.status}) ${query.after ? sql`AND id>${query.after}::uuid` : sql``} ORDER BY id LIMIT ${query.limit+1}`)).rows as unknown as Row[];
      return { items: result.slice(0,query.limit).map(dto), next_cursor: result.length>query.limit ? result[query.limit-1]!.id : null, role: member.role, email_available: this.emailAvailable };
    });
  }
  async create(actor: string, workspace: string, input: unknown): Promise<InvitationResult> {
    const request = parseInvitationInput(input), requestHash = digest(JSON.stringify(request));
    const token = randomBytes(32).toString('base64url');
    return sessionTransaction(this.db, async c => {
      await this.authorize(c, actor, workspace, request.role, request.guest_type);
      const prior = (await c.execute(sql`SELECT ${columns} FROM workspace_invitations WHERE workspace_id=${workspace} AND request_id=${request.request_id}`)).rows[0] as unknown as Row | undefined;
      if (prior) {
        if (prior.created_by !== actor || prior.request_hash !== requestHash) throw new AppError(409, 'idempotency_conflict');
        return { invitation: dto(prior) };
      }
      await this.channels(c, actor, workspace, request.channel_ids);
      if (request.email) {
        // Expired tokens stay invalid; a fresh invitation can reuse the same email.
        await c.execute(sql`UPDATE workspace_invitations SET revoked_at=now() WHERE workspace_id=${workspace} AND email=${request.email} AND revoked_at IS NULL AND use_count=0 AND expires_at<=now()`);
        const pending = (await c.execute(sql`SELECT id FROM workspace_invitations WHERE workspace_id=${workspace} AND email=${request.email} AND revoked_at IS NULL AND use_count=0`)).rows;
        if (pending.length) throw new AppError(409, 'invitation_already_pending');
      }
      const count = (await c.execute(sql`SELECT count(*)::int AS count FROM workspace_invitations WHERE workspace_id=${workspace} AND revoked_at IS NULL AND use_count<use_limit AND expires_at>now()`)).rows[0] as {count:number};
      if (count.count>=1000) throw new AppError(409, 'invitation_limit');
      const status = request.kind === 'link' ? 'not_applicable' : this.emailAvailable ? 'queued' : 'unavailable';
      const row = (await c.execute(sql`INSERT INTO workspace_invitations(id,workspace_id,request_id,request_hash,kind,email,role,guest_type,channel_ids,created_by,token_hash,expires_at,expires_in_days,use_limit,delivery_status)
        VALUES(${randomUUID()},${workspace},${request.request_id},${requestHash},${request.kind},${request.email},${request.role},${request.guest_type},${sql.param(request.channel_ids)}::uuid[],${actor},${digest(token)},now()+${request.expires_in_days}*interval '1 day',${request.expires_in_days},${request.use_limit},${status}) RETURNING ${columns}`)).rows[0] as unknown as Row;
      await this.queueEmail(c, row, token);
      await this.audit(c, actor, row, 'invitation.created');
      return { invitation: dto(row), token };
    });
  }
  private async managed(c: DbSession, actor: string, workspace: string, id: string) {
    const member = await this.actor(c, actor, workspace);
    const row = (await c.execute(sql`SELECT ${columns} FROM workspace_invitations WHERE workspace_id=${workspace} AND id=${uuid(id)}`)).rows[0] as unknown as Row | undefined;
    if (!row) throw unavailable();
    if (member.role === 'member' && row.created_by !== actor || row.role === 'admin' && member.role !== 'owner') throw new AppError(403, 'invitation_forbidden');
    return row;
  }
  async revoke(actor: string, workspace: string, id: string) {
    return sessionTransaction(this.db, async c => {
      const row = await this.managed(c, actor, workspace, id);
      if (row.revoked_at) return;
      await c.execute(sql`UPDATE workspace_invitations SET revoked_at=now() WHERE id=${row.id}`);
      await c.execute(sql`UPDATE workspace_invitation_emails SET state='cancelled',token_ciphertext=NULL WHERE invitation_id=${row.id} AND state='pending'`);
      await this.audit(c, actor, row, 'invitation.revoked');
    });
  }
  async resend(actor: string, workspace: string, id: string, input: unknown): Promise<InvitationResult> {
    const requestId = uuid(record(input,['request_id']).request_id), token = randomBytes(32).toString('base64url');
    return sessionTransaction(this.db, async c => {
      const row = await this.managed(c, actor, workspace, id);
      await this.authorize(c, actor, workspace, row.role, row.guest_type);
      if ((await c.execute(sql`SELECT 1 FROM workspace_invitation_resends WHERE invitation_id=${row.id} AND request_id=${requestId}`)).rows.length) return {invitation:dto(row)};
      if (row.revoked_at || row.kind !== 'email' || row.use_count) throw new AppError(409,'invitation_not_pending');
      await this.channels(c, actor, workspace, row.channel_ids);
      const updated = (await c.execute(sql`UPDATE workspace_invitations SET token_hash=${digest(token)},version=version+1,created_by=${actor},expires_at=now()+expires_in_days*interval '1 day',delivery_status=${this.emailAvailable?'queued':'unavailable'} WHERE id=${row.id} RETURNING ${columns}`)).rows[0] as unknown as Row;
      await c.execute(sql`INSERT INTO workspace_invitation_resends(invitation_id,request_id,version) VALUES(${row.id},${requestId},${updated.version})`);
      await c.execute(sql`UPDATE workspace_invitation_emails SET state='cancelled',token_ciphertext=NULL WHERE invitation_id=${row.id} AND state='pending'`);
      await this.queueEmail(c, updated, token);
      await this.audit(c, actor, updated, 'invitation.resent');
      return {invitation:dto(updated),token};
    });
  }
  private async byToken(c: DbSession, token: string) {
    const row = (await c.execute(sql`SELECT ${columns} FROM workspace_invitations WHERE token_hash=${digest(invitationToken(token))}`)).rows[0] as unknown as Row | undefined;
    if (!row || row.revoked_at || new Date(row.expires_at).getTime()<=Date.now()) throw unavailable();
    return row;
  }
  async preview(actor: string, token: string): Promise<InvitationPreview> {
    return sessionTransaction(this.db, async c => {
      const row = await this.byToken(c, token);
      if (row.use_count>=row.use_limit && !(await c.execute(sql`SELECT 1 FROM workspace_invitation_acceptances WHERE invitation_id=${row.id} AND user_id=${uuid(actor)}`)).rows.length) throw unavailable();
      const user = (await c.execute(sql`SELECT email,email_verified FROM users WHERE id=${uuid(actor)}`)).rows[0] as {email:string|null;email_verified:boolean}|undefined;
      if (!user) throw new AppError(401,'unauthenticated');
      const workspace = (await c.execute(sql`SELECT name FROM workspaces WHERE id=${row.workspace_id}`)).rows[0] as {name:string};
      return {workspace_id:row.workspace_id,workspace_name:workspace.name,kind:row.kind,role:row.role,guest_type:row.guest_type,expires_at:new Date(row.expires_at).toISOString(),email_matches:row.kind==='link'||user.email?.toLowerCase()===row.email,email_verified:user.email_verified};
    });
  }
  async accept(actor: string, token: string): Promise<InvitationAcceptance> {
    return sessionTransaction(this.db, async c => {
      const row = await this.byToken(c, token);
      const user = (await c.execute(sql`SELECT email,email_verified FROM users WHERE id=${uuid(actor)}`)).rows[0] as {email:string|null;email_verified:boolean}|undefined;
      if (!user) throw new AppError(401,'unauthenticated');
      if (row.kind==='email' && user.email?.toLowerCase()!==row.email) throw new AppError(403,'invitation_email_mismatch');
      if (row.kind==='email' && !user.email_verified) throw new AppError(403,'invitation_email_unverified');
      const existing = (await c.execute(sql`SELECT active FROM workspace_members WHERE workspace_id=${row.workspace_id} AND user_id=${actor}`)).rows[0] as {active:boolean}|undefined;
      // An invitation never reverses a deliberate deactivation or changes an existing role.
      if (existing && !existing.active) throw new AppError(403,'workspace_account_deactivated');
      if ((await c.execute(sql`SELECT 1 FROM workspace_invitation_acceptances WHERE invitation_id=${row.id} AND user_id=${actor}`)).rows.length) return {workspace_id:row.workspace_id,already_member:true};
      await this.authorize(c,row.created_by,row.workspace_id,row.role,row.guest_type);
      await this.channels(c,row.created_by,row.workspace_id,row.channel_ids);
      const changed = (await c.execute(sql`UPDATE workspace_invitations SET use_count=use_count+1 WHERE id=${row.id} AND token_hash=${digest(token)} AND revoked_at IS NULL AND expires_at>now() AND use_count<use_limit RETURNING id`)).rows;
      if (!changed.length) throw unavailable();
      await c.execute(sql`INSERT INTO workspace_invitation_acceptances(invitation_id,user_id) VALUES(${row.id},${actor})`);
      if (!existing) {
        await c.execute(sql`INSERT INTO workspace_members(workspace_id,user_id,role,guest_type) VALUES(${row.workspace_id},${actor},${row.role},${row.guest_type})`);
        for (const channel of row.channel_ids) await c.execute(sql`INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES(${row.workspace_id},${channel},${actor}) ON CONFLICT DO NOTHING`);
        if (row.guest_type==='none') await joinDefaultChannels(c,actor,row.workspace_id);
      }
      await this.audit(c,actor,row,'invitation.accepted');
      return {workspace_id:row.workspace_id,already_member:!!existing};
    });
  }
  async emailAttempt(id: string): Promise<{ id:string; invitation_id:string; version:number; email:string; workspace_name:string; token:string; attempts:number }|null> {
    if (!this.options.emailEncryptionKey) return null;
    const job = await sessionTransaction(this.db, async c => {
      await c.execute(sql`UPDATE workspace_invitation_emails j SET state='cancelled',token_ciphertext=NULL FROM workspace_invitations i WHERE j.id=${uuid(id)} AND j.invitation_id=i.id AND j.state='pending' AND (i.version<>j.version OR i.revoked_at IS NOT NULL OR i.expires_at<=now() OR i.use_count>=i.use_limit)`);
      const row = (await c.execute(sql`UPDATE workspace_invitation_emails SET attempts=attempts+1 WHERE id=${id} AND state='pending' AND attempts<5 RETURNING *`)).rows[0] as {id:string;invitation_id:string;version:number;token_ciphertext:string;attempts:number}|undefined;
      if (!row) return null;
      const detail = (await c.execute(sql`SELECT i.email,w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.id=${row.invitation_id}`)).rows[0] as {email:string;workspace_name:string};
      return {...row,...detail};
    });
    if (!job) { await this.emailFinished(id,false); return null; }
    const bytes = Buffer.from(job.token_ciphertext,'base64'), decipher = createDecipheriv('aes-256-gcm',Buffer.from(this.options.emailEncryptionKey,'hex'),bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(`${job.invitation_id}:${job.version}`)); decipher.setAuthTag(bytes.subarray(12,28));
    const token = Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
    return {id:job.id,invitation_id:job.invitation_id,version:job.version,email:job.email,workspace_name:job.workspace_name,token,attempts:job.attempts};
  }
  async emailFinished(id: string, sent: boolean) {
    await sessionTransaction(this.db,async c=>{
      const job=(await c.execute(sql`UPDATE workspace_invitation_emails SET state=${sent?'sent':'failed'},token_ciphertext=NULL,sent_at=${sent?sql`now()`:sql`NULL`} WHERE id=${uuid(id)} AND ${sent?sql`state IN ('pending','failed')`:sql`state='pending' AND attempts>=5`} RETURNING invitation_id,version`)).rows[0] as {invitation_id:string;version:number}|undefined;
      if(job) await c.execute(sql`UPDATE workspace_invitations SET delivery_status=${sent?'sent':'failed'} WHERE id=${job.invitation_id} AND version=${job.version}`);
    });
  }
}
