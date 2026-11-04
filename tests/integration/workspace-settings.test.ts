import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { parseWorkspaceSettingsUpdate } from '@space/contracts';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { WorkspaceSettingsStore, requireWorkspacePolicy, joinDefaultChannels } from '@space/postgres/workspace-settings';
import { database } from '@space/postgres/database';
import { createApi } from '@space/server/api';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required');
const schema=`settings_${randomBytes(8).toString('hex')}`;
const admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const store=new WorkspaceSettingsStore(pool),app=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function api(token:string,method:'GET'|'POST'|'PATCH',path:string,body?:object,status=200){
 const response=await app.inject({method,url:`/v1${path}`,headers:{authorization:`Bearer ${token}`},...(body?{payload:body}:{})});
 assert.equal(response.statusCode,status,response.body);return response.json();
}

test('settings validation rejects unsafe images, unknown fields, invalid domains and unbounded input',()=>{
 for(const patch of [{icon_url:'data:image/svg+xml;base64,PHN2Zz4='},{icon_url:'https://tracker.test/image.png'},{icon_url:'data:image/png;base64,YQ=='},{slug:'bad/url'},{approved_email_domains:['*.example.com']},{approved_email_domains:['a..example.com']},{default_channel_ids:Array.from({length:26},()=>randomUUID())},{retention_days:0},{retention_days:1.5},{role:'owner'},{revision:0},{language:'unknown'}])assert.throws(()=>parseWorkspaceSettingsUpdate({revision:'0',...patch}),{status:400});
 const valid=parseWorkspaceSettingsUpdate({revision:'0',slug:' Design-Team ',approved_email_domains:['EXAMPLE.COM','example.com']});assert.equal(valid.slug,'design-team');assert.deepEqual(valid.approved_email_domains,['example.com']);
});
test('settings persist with backwards-compatible defaults, membership boundaries, and atomic revision checks',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool),path=`/workspaces/${a.workspace_id}/settings`;
 const initial=await api(a.owner_token,'GET',path);assert.equal(initial.revision,'0');assert.equal(initial.email_visibility,'admins');assert.equal(initial.invite_permission,'admins');assert.equal(initial.create_channel_permission,'members');
 await api(b.owner_token,'GET',path,undefined,404);await api(a.collaborator_token,'PATCH',path,{revision:'0',description:'No'},403);
 const image='data:image/png;base64,iVBORw0KGgo=';
 const saved=await api(a.owner_token,'PATCH',path,{revision:'0',name:'Design',description:'Our team',icon_url:image,language:'vi',display_name_guidelines:'First and last name',default_channel_ids:[a.channel_id],retention_days:365});
 assert.equal(saved.name,'Design');assert.equal(saved.icon_url,image);assert.equal(saved.revision,'1');assert.equal(saved.retention_days,365);
 await api(a.owner_token,'PATCH',path,{revision:'0',name:'Lost update'},409);
 assert.equal((await api(a.owner_token,'GET',path)).name,'Design');
 const results=await Promise.allSettled([store.update(a.owner_id,a.workspace_id,{revision:'1',description:'A'}),store.update(a.owner_id,a.workspace_id,{revision:'1',description:'B'})]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.status===409).length,1);
 assert.equal((await store.read(a.owner_id,a.workspace_id)).revision,'2');
 const audit=await pool.query("SELECT payload FROM workspace_events WHERE workspace_id=$1 AND type='workspace.settings_updated'",[a.workspace_id]);assert.equal(audit.rowCount,2);assert.ok(!JSON.stringify(audit.rows).includes(image));
});
test('default channels reject private, archived and foreign channels; slugs are canonical and uniquely claimed',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool);
 await assert.rejects(store.update(a.owner_id,a.workspace_id,{revision:'0',default_channel_ids:[b.channel_id]}),{status:400});
 await pool.query('UPDATE channels SET private=true WHERE id=$1',[a.channel_id]);await assert.rejects(store.update(a.owner_id,a.workspace_id,{revision:'0',default_channel_ids:[a.channel_id]}),{status:400});
 await pool.query('UPDATE channels SET private=false,archived_at=now() WHERE id=$1',[a.channel_id]);await assert.rejects(store.update(a.owner_id,a.workspace_id,{revision:'0',default_channel_ids:[a.channel_id]}),{status:400});
 const slug=`team-${randomBytes(4).toString('hex')}`;
 const claims=await Promise.allSettled([store.update(a.owner_id,a.workspace_id,{revision:'0',slug:slug.toUpperCase()}),store.update(b.owner_id,b.workspace_id,{revision:'0',slug})]);
 assert.equal(claims.filter(result=>result.status==='fulfilled').length,1);assert.equal(claims.filter(result=>result.status==='rejected'&&result.reason.status===409).length,1);
});
test('approved-domain joins require verified exact domains, assign defaults once, and cannot reactivate removed accounts',async()=>{
 const a=await bootstrap(pool),b=await bootstrap(pool),slug=`join-${randomBytes(4).toString('hex')}`;
 await store.update(a.owner_id,a.workspace_id,{revision:'0',slug,approved_email_domains:['example.test'],default_channel_ids:[a.channel_id]});
 await pool.query('UPDATE users SET email=$1,email_verified=false WHERE id=$2',[`${b.owner_id}@example.test`,b.owner_id]);
 await api(b.owner_token,'GET',`/workspaces/by-slug/${slug}`,undefined,404);
 await api(b.owner_token,'POST',`/workspaces/by-slug/${slug}/join`,{},403);
 await pool.query('UPDATE users SET email_verified=true,email=$1 WHERE id=$2',[`${b.owner_id}@sub.example.test`,b.owner_id]);
 await api(b.owner_token,'POST',`/workspaces/by-slug/${slug}/join`,{},403);
 await pool.query('UPDATE users SET email=$1 WHERE id=$2',[`${b.owner_id}@example.test`,b.owner_id]);
 const joined=await Promise.all([api(b.owner_token,'POST',`/workspaces/by-slug/${slug}/join`,{}),api(b.owner_token,'POST',`/workspaces/by-slug/${slug}/join`,{})]);
 assert.ok(joined.every(value=>value.role==='member'));assert.equal((await pool.query('SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,b.owner_id])).rowCount,1);
 assert.equal((await pool.query("SELECT 1 FROM workspace_events WHERE workspace_id=$1 AND type='member.joined_by_domain'",[a.workspace_id])).rowCount,1);
 assert.equal((await api(b.owner_token,'GET',`/workspaces/by-slug/${slug}`)).workspace_id,a.workspace_id);
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,b.owner_id]);
 await api(b.owner_token,'POST',`/workspaces/by-slug/${slug}/join`,{},403);
});

test('policies enforce member permissions and never grant guests invitation, channel creation, or default channel access',async()=>{
 const a=await bootstrap(pool),db=database(pool);
 const check=(action:'invite'|'create_channel')=>db.transaction(c=>requireWorkspacePolicy(c,a.collaborator_id,a.workspace_id,action));
 await assert.rejects(check('invite'),{status:403});await check('create_channel');
 await store.update(a.owner_id,a.workspace_id,{revision:'0',invite_permission:'members',create_channel_permission:'admins',default_channel_ids:[a.channel_id]});
 await check('invite');await assert.rejects(check('create_channel'),{status:403});
 await store.update(a.owner_id,a.workspace_id,{revision:'1',create_channel_permission:'members'});
 await pool.query("UPDATE workspace_members SET guest_type='multi' WHERE workspace_id=$1 AND user_id=$2",[a.workspace_id,a.collaborator_id]);
 await assert.rejects(check('invite'),{status:403});await assert.rejects(check('create_channel'),{status:403});
 await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
 await db.transaction(c=>joinDefaultChannels(c,a.collaborator_id,a.workspace_id));
 assert.equal((await pool.query('SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id])).rowCount,0);
});
