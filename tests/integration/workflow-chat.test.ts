import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { createApi } from '@space/server/api';

test('workflow posts retain their sender in events and history, including retried posts and DMs', async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  const schema = 'workflow_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({ connectionString, options: '-c search_path=' + schema });
  let app: ReturnType<typeof createApi> | undefined;
  t.after(async () => {
    await app?.close();
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  await migrate(pool);
  const s = await bootstrap(pool), other = await bootstrap(pool);
  const token = randomUUID();
  const api = app = createApi(new PostgresStore(pool), { allowDevelopmentTokens:true, workflowChat: {
    token, actor:s.owner_id, workspace:s.workspace_id, help:s.channel_id, onCall:other.channel_id
  }});
  const post = (payload:object, credential:string=token) => api.inject({ method:'POST', url:'/v1/workflow-messages',
    headers:{ authorization:'Bearer ' + credential }, payload });
  const body = { key:'run1/triage', workflowName:'IT Help Request', target:'channel', destination:'#help', text:'VPN is down' };
  assert.equal((await post(body, s.owner_token)).statusCode,401);
  assert.equal((await post({...body,destination:'#on-call'})).statusCode,404);
  const delivered = await Promise.all([post(body),post(body)]);
  for (const r of delivered) assert.equal(r.statusCode,201,r.body);
  assert.equal(delivered[0]!.json().id,delivered[1]!.json().id);
  assert.equal((await post({...body,workflowName:'Different'})).statusCode,409);
  const get = async (channel:string,path:string) => (await api.inject({ method:'GET',url:'/v1/channels/'+channel+'/'+path,
    headers:{authorization:'Bearer '+s.collaborator_token} })).json();
  const author={kind:'workflow',id:s.owner_id,name:'IT Help Request'};
  assert.deepEqual((await get(s.channel_id,'messages')).messages.map((m:{author:object})=>m.author),[author]);
  assert.deepEqual((await get(s.channel_id,'history')).events[0].payload.author,author);
  const dm = await post({...body,key:'run1/notify',target:'person',destination:s.collaborator_id,text:'Claimed by Sam'});
  assert.equal(dm.statusCode,201,dm.body);
  assert.deepEqual((await get(dm.json().channel_id,'messages')).messages[0].author,author);
  const forged = await api.inject({method:'POST',url:'/v1/channels/'+s.channel_id+'/messages',
    headers:{authorization:'Bearer '+s.owner_token},payload:{client_message_id:randomUUID(),text:'hi',workflowName:'fake'}});
  assert.equal(forged.statusCode,400);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[s.channel_id,s.owner_id]);
  assert.equal((await post({...body,key:'run2/triage'})).statusCode,404);
});
