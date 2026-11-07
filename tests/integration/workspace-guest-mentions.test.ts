import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';
const schema=`guest_mentions_${randomBytes(8).toString('hex')}`;
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const app=createApi(new PostgresStore(pool),{allowDevelopmentTokens:true});
before(async()=>{assert.ok(process.env.TEST_DATABASE_URL);await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function api(token:string,method:'GET'|'POST',path:string,payload?:object,status=200) {
  const response=await app.inject({method,url:`/v1${path}`,headers:{authorization:`Bearer ${token}`},payload});
  assert.equal(response.statusCode,status,`${path}: ${response.body}`);return response.json();
}
async function fixture(kind:'single'|'multi') {
  const workspace=await bootstrap(pool),guest=await bootstrap(pool);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[workspace.channel_id,workspace.collaborator_id]);
  await pool.query("UPDATE users SET display_name='Unrelated person',full_name='Private full name',title='Private title' WHERE id=$1",[workspace.collaborator_id]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,guest_type) VALUES($1,$2,'member',$3)",[workspace.workspace_id,guest.owner_id,kind]);
  await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)',[workspace.workspace_id,workspace.channel_id,guest.owner_id]);
  return {workspace,guest};
}
const mention=(id:string)=>({client_message_id:randomUUID(),text:'@Unrelated person hello',document:{ops:[{insert:'@Unrelated person',attributes:{mention:{kind:'user',id,label:'Unrelated person'}}},{insert:' hello\n'}]}});
test('guests can mention their channel but cannot notify the general channel with everyone',async()=>{
  const {workspace:a,guest:g}=await fixture('multi');
  const directory=await api(g.owner_token,'GET',`/channels/${a.channel_id}/mentions`);
  assert.ok(directory.items.some((item:{id:string})=>item.id==='channel'));
  assert.ok(!directory.items.some((item:{id:string})=>item.id==='everyone'));
  const broadcast=(id:string)=>({client_message_id:randomUUID(),text:`@${id}`,document:{ops:[{insert:`@${id}`,attributes:{mention:{kind:'broadcast',id,label:id}}}]}});
  await api(g.owner_token,'POST',`/channels/${a.channel_id}/messages`,broadcast('everyone'),403);
  await api(g.owner_token,'POST',`/channels/${a.channel_id}/messages`,broadcast('channel'),201);
});
for(const kind of ['single','multi'] as const)test(`${kind} guests cannot enumerate, inspect or mention unrelated workspace people`,async()=>{
  const {workspace:a,guest:g}=await fixture(kind),base=`/channels/${a.channel_id}/mentions`;
  const all=await api(g.owner_token,'GET',base);
  assert.ok(all.items.some((item:{id:string})=>item.id===a.owner_id));
  assert.ok(!all.items.some((item:{id:string})=>item.id===a.collaborator_id));
  assert.deepEqual((await api(g.owner_token,'GET',`${base}?q=Unrelated`)).items,[]);
  await api(g.owner_token,'GET',`${base}/user/${a.collaborator_id}`,undefined,404);
  await api(g.owner_token,'POST',`/channels/${a.channel_id}/messages`,mention(a.collaborator_id),404);
  await api(g.owner_token,'GET',`${base}/user/${a.owner_id}`);
  // Ordinary members retain workspace-wide mention discovery.
  assert.equal((await api(a.owner_token,'GET',`${base}?q=Unrelated`)).items[0].id,a.collaborator_id);
  await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)',[a.workspace_id,a.channel_id,a.collaborator_id]);
  assert.equal((await api(g.owner_token,'GET',`${base}?q=Unrelated`)).items[0].id,a.collaborator_id);
  await api(g.owner_token,'POST',`/channels/${a.channel_id}/messages`,mention(a.collaborator_id),201);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[a.channel_id,a.collaborator_id]);
  await api(g.owner_token,'GET',`${base}/user/${a.collaborator_id}`,undefined,404);
});
