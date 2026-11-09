import { observeOutbox } from '../fixtures/observe-outbox.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap, tokenHash } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
import { WorkspaceInvitationStore } from '@space/postgres/workspace-invitations';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required');
const schema=`invitations_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const store=new WorkspaceInvitationStore(pool);
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool); await observeOutbox(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function person(email=`${randomUUID()}@example.test`,verified=true){const id=randomUUID();await pool.query('INSERT INTO users(id,display_name,email,email_verified) VALUES($1,$2,$3,$4)',[id,'Invited person',email,verified]);return {id,email};}
const error=(code:string)=>(value:unknown)=>value instanceof Error&&value.message===code;

test('email invitation is account-bound, verified, audited and idempotently accepted with assigned channels',async()=>{
 const a=await bootstrap(pool),user=await person(undefined,false),other=await person();
 const input={request_id:randomUUID(),email:user.email,channel_ids:[a.channel_id]};
 const created=await store.create(a.owner_id,a.workspace_id,input);assert.ok(created.token);assert.equal(created.invitation.delivery_status,'unavailable');
 const saved=(await pool.query('SELECT token_hash FROM workspace_invitations WHERE id=$1',[created.invitation.id])).rows[0];assert.notEqual(saved.token_hash,created.token);
 const replay=await store.create(a.owner_id,a.workspace_id,input);assert.equal(replay.invitation.id,created.invitation.id);assert.equal(replay.token,undefined);
 await assert.rejects(store.create(a.owner_id,a.workspace_id,{...input,role:'admin'}),error('idempotency_conflict'));
 await assert.rejects(store.accept(other.id,created.token!),error('invitation_email_mismatch'));
 await assert.rejects(store.accept(user.id,created.token!),error('invitation_email_unverified'));
 await pool.query('UPDATE users SET email_verified=true WHERE id=$1',[user.id]);
 assert.equal((await store.accept(user.id,created.token!)).already_member,false);
 assert.equal((await store.accept(user.id,created.token!)).already_member,true);
 assert.equal((await pool.query('SELECT role,guest_type FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,user.id])).rows[0].role,'member');
 assert.equal((await pool.query('SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,user.id])).rowCount,1);
 assert.equal((await store.list(a.owner_id,a.workspace_id,{status:'accepted'})).items.length,1);
 assert.equal((await pool.query("SELECT 1 FROM workspace_events WHERE workspace_id=$1 AND type='invitation.accepted'",[a.workspace_id])).rowCount,1);
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,user.id]);
 await assert.rejects(store.accept(user.id,created.token!),error('workspace_account_deactivated'));
});

test('resend rotates once per request, old tokens stop working, revoke and expiry prevent acceptance',async()=>{
 const a=await bootstrap(pool),user=await person();
 const first=await store.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),email:user.email});
 await assert.rejects(store.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),email:user.email}),error('invitation_already_pending'));
 const req={request_id:randomUUID()},fresh=await store.resend(a.owner_id,a.workspace_id,first.invitation.id,req);
 assert.notEqual(first.token,fresh.token);assert.equal(fresh.invitation.version,2);
 assert.equal((await store.resend(a.owner_id,a.workspace_id,first.invitation.id,req)).invitation.version,2);
 await assert.rejects(store.accept(user.id,first.token!),error('invitation_unavailable'));
 await pool.query("UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[first.invitation.id]);
 await assert.rejects(store.accept(user.id,fresh.token!),error('invitation_unavailable'));
 assert.equal((await store.list(a.owner_id,a.workspace_id,{status:'expired'})).items.length,1);
 const renewed=await store.resend(a.owner_id,a.workspace_id,first.invitation.id,{request_id:randomUUID()});
 await store.revoke(a.owner_id,a.workspace_id,first.invitation.id);await store.revoke(a.owner_id,a.workspace_id,first.invitation.id);
 await assert.rejects(store.accept(user.id,renewed.token!),error('invitation_unavailable'));
 assert.equal((await store.list(a.owner_id,a.workspace_id,{status:'revoked'})).items.length,1);
});

test('concurrent link acceptance cannot exceed its use limit or double-count one person',async()=>{
 const a=await bootstrap(pool),one=await person(),two=await person();
 const link=await store.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),kind:'link',use_limit:1});
 const results=await Promise.allSettled([store.accept(one.id,link.token!),store.accept(two.id,link.token!)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await pool.query('SELECT use_count FROM workspace_invitations WHERE id=$1',[link.invitation.id])).rows[0].use_count,1);
 const another=await store.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),kind:'link',use_limit:2});
 await Promise.all([store.accept(one.id,another.token!),store.accept(one.id,another.token!)]);
 assert.equal((await pool.query('SELECT use_count FROM workspace_invitations WHERE id=$1',[another.invitation.id])).rows[0].use_count,1);
});

test('invitation authority and private-channel checks prevent privilege escalation and cross-workspace grants',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool),user=await person();
 await assert.rejects(store.create(a.collaborator_id,a.workspace_id,{request_id:randomUUID(),kind:'link'}),error('invite_forbidden'));
 await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[a.workspace_id,a.collaborator_id]);
 await assert.rejects(store.create(a.collaborator_id,a.workspace_id,{request_id:randomUUID(),kind:'link',role:'admin'}),error('invitation_forbidden'));
 await assert.rejects(store.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),kind:'link',channel_ids:[b.channel_id]}),error('invitation_channel_forbidden'));
 const privateId=randomUUID();await pool.query("INSERT INTO channels(id,workspace_id,name,private,created_by) VALUES($1,$2,'secret',true,$3)",[privateId,a.workspace_id,a.owner_id]);
 await assert.rejects(store.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),kind:'link',channel_ids:[privateId]}),error('invitation_channel_forbidden'));
 const allowed=await store.create(a.collaborator_id,a.workspace_id,{request_id:randomUUID(),email:user.email});
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
 await assert.rejects(store.accept(user.id,allowed.token!),error('not_found'));
 await assert.rejects(store.list(b.owner_id,a.workspace_id),error('not_found'));
});

test('guest invitations set restricted membership and never upgrade an existing guest or owner',async()=>{
 const a=await bootstrap(pool),user=await person();
 const guest=await store.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),kind:'link',guest_type:'single',channel_ids:[a.channel_id]});
 await store.accept(user.id,guest.token!);
 const member=(await pool.query('SELECT guest_type,guest_channel_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,user.id])).rows[0];
 assert.equal(member.guest_type,'single');assert.equal(member.guest_channel_id,a.channel_id);
 const regular=await store.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),kind:'link',role:'admin'});
 await store.accept(user.id,regular.token!);
 assert.equal((await pool.query('SELECT guest_type,role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,user.id])).rows[0].role,'member');
 await store.accept(a.owner_id,guest.token!);
 assert.equal((await pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.owner_id])).rows[0].role,'owner');
});

test('SMTP outbox encrypts tokens, emits durable targeted events, cancels stale versions and bounds delivery attempts',async()=>{
 const mail=new WorkspaceInvitationStore(pool,{emailEncryptionKey:'11'.repeat(32)}),a=await bootstrap(pool),user=await person();
 const invite=await mail.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),email:user.email});
 const job=(await pool.query('SELECT * FROM workspace_invitation_emails WHERE invitation_id=$1',[invite.invitation.id])).rows[0];
 assert.equal(invite.invitation.delivery_status,'queued');assert.ok(!JSON.stringify(job).includes(invite.token!));
 const event=(await pool.query("SELECT payload FROM observed_outbox WHERE kind='invitation.email_requested' AND aggregate_id=$1",[job.id])).rows[0];assert.deepEqual(event.payload,{email_id:job.id});
 const decoded=await mail.emailAttempt(job.id);assert.equal(decoded?.token,invite.token);assert.equal(decoded?.attempts,1);
 const rotated=await mail.resend(a.owner_id,a.workspace_id,invite.invitation.id,{request_id:randomUUID()});assert.equal(await mail.emailAttempt(job.id),null);
 const next=(await pool.query('SELECT id FROM workspace_invitation_emails WHERE invitation_id=$1 AND version=$2',[invite.invitation.id,rotated.invitation.version])).rows[0];
 for(let n=1;n<=5;n++)assert.equal((await mail.emailAttempt(next.id))?.attempts,n);
 await mail.emailFinished(next.id,false);assert.equal(await mail.emailAttempt(next.id),null);
 assert.equal((await mail.list(a.owner_id,a.workspace_id)).items[0]?.delivery_status,'failed');
 assert.equal((await pool.query('SELECT token_ciphertext FROM workspace_invitation_emails WHERE id=$1',[next.id])).rows[0].token_ciphertext,null);
});

test('member invite policy scopes management to their own invitations and regular invitees join default channels',async()=>{
 const a=await bootstrap(pool),user=await person();
 await pool.query("INSERT INTO workspace_preferences(workspace_id,invite_permission,default_channel_ids) VALUES($1,'members',$2) ON CONFLICT(workspace_id) DO UPDATE SET invite_permission='members',default_channel_ids=$2",[a.workspace_id,[a.channel_id]]);
 const invite=await store.create(a.collaborator_id,a.workspace_id,{request_id:randomUUID(),email:user.email});
 const owners=await store.create(a.owner_id,a.workspace_id,{request_id:randomUUID(),kind:'link'});
 assert.equal((await store.list(a.collaborator_id,a.workspace_id,{kind:'link'})).items.length,0);
 await assert.rejects(store.revoke(a.collaborator_id,a.workspace_id,owners.invitation.id),error('invitation_forbidden'));
 await store.accept(user.id,invite.token!);
 assert.equal((await pool.query('SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,user.id])).rowCount,1);
});


test('HTTP invitation routes require authentication and return only safe preview and management fields',async()=>{
 const app=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});
 try{
  const a=await bootstrap(pool),user=await person(),userToken=randomBytes(32).toString('hex');
  await pool.query('INSERT INTO human_credentials(user_id,token_hash) VALUES($1,$2)',[user.id,tokenHash(userToken)]);
  const path=`/v1/workspaces/${a.workspace_id}/invitations`;
  assert.equal((await app.inject({method:'GET',url:path})).statusCode,401);
  const result=await app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${a.owner_token}`},payload:{request_id:randomUUID(),email:user.email}});
  assert.equal(result.statusCode,201,result.body);const created=result.json();assert.ok(created.token);assert.equal(created.invitation.token_hash,undefined);
  const invitePath=`/v1/invitations/${created.token}`;
  assert.equal((await app.inject({method:'GET',url:invitePath})).statusCode,401);
  const preview=await app.inject({method:'GET',url:invitePath,headers:{authorization:`Bearer ${userToken}`}});
  assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().email_matches,true);assert.equal(preview.json().email,undefined);
  const accepted=await app.inject({method:'POST',url:`${invitePath}/accept`,headers:{authorization:`Bearer ${userToken}`},payload:{}});
  assert.equal(accepted.statusCode,200,accepted.body);assert.equal(accepted.json().workspace_id,a.workspace_id);
 }finally{await app.close();}
});
