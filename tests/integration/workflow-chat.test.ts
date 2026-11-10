import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { HelpWorkflows } from '@space/postgres/help-workflows';
import { database } from '@space/postgres/database';
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
  const list = (workspace: string, credential: string) => app!.inject({
    method: 'GET', url: '/v1/workspaces/' + workspace + '/workflows', headers: { authorization: 'Bearer ' + credential }
  });
  const catalog = await list(s.workspace_id, s.collaborator_token);
  assert.equal(catalog.statusCode, 200);
  const [workflow] = catalog.json().items;
  assert.equal(workflow.name, 'IT Help Request');
  assert.deepEqual(workflow.destinations.map((route: { urgency: string; channel: { id: string } }) =>
    [route.urgency, route.channel.id]), [['normal', s.channel_id]]);
  assert.equal((await list(s.workspace_id, other.owner_token)).statusCode, 404);
  assert.deepEqual((await list(other.workspace_id, other.owner_token)).json().items, []);
  const path = '/v1/workspaces/' + s.workspace_id + '/workflows/published';
  const publishBody = {id:randomUUID(),name:'IT Help Request',normal_channel:s.channel_id,urgent_channel:s.channel_id};
  const publish = (payload=publishBody, credential=s.owner_token) => api.inject({method:'POST',url:path,headers:{authorization:'Bearer '+credential},payload});
  const copies = await Promise.all([publish(),publish()]);
  for (const copy of copies) assert.equal(copy.statusCode,201,copy.body);
  assert.equal((await publish({...publishBody,name:'Different'})).statusCode,409);
  assert.equal((await publish(publishBody,other.owner_token)).statusCode,403);
  assert.equal((await publish({...publishBody,id:randomUUID(),urgent_channel:other.channel_id})).statusCode,404);
  const publishedList = (query:string) => api.inject({method:'GET',url:path+query,headers:{authorization:'Bearer '+s.collaborator_token}});
  assert.equal((await publishedList('')).json().items.length,1);
  assert.deepEqual((await publishedList('?mine=true')).json().items,[]);
  const publications = new HelpWorkflows(database(pool), {actor:s.owner_id,workspace:s.workspace_id,help:s.channel_id,onCall:s.channel_id});
  const requestId = randomUUID();
  const prepare = (description:string) => publications.prepare(s.collaborator_id,publishBody.id,requestId,'normal',description);
  const starts = await Promise.all([prepare('VPN issue'),prepare('VPN issue')]);
  assert.ok(starts.every(start => start.channel === s.channel_id && !start.started));
  await publications.acknowledge(s.collaborator_id,publishBody.id,requestId);
  assert.equal((await prepare('VPN issue')).started,true);
  await assert.rejects(prepare('Changed'),/workflow_request_conflict/);
  const edit = (name:string,revision:number,credential=s.owner_token) => api.inject({method:'PATCH',url:path+'/'+publishBody.id,
    headers:{authorization:'Bearer '+credential},payload:{normal_channel:s.channel_id,urgent_channel:s.channel_id,name,revision}});
  assert.equal((await edit('Denied',1,s.collaborator_token)).statusCode,404);
  const edits = await Promise.all([edit('IT Support',1),edit('Support desk',1)]);
  assert.deepEqual(edits.map(r=>r.statusCode).sort(),[204,409]);
  const edited = edits[0]!.statusCode === 204 ? 'IT Support' : 'Support desk';
  assert.equal((await edit(edited,1)).statusCode,204);
  assert.equal((await prepare('VPN issue')).name,'IT Help Request');
  assert.equal((await publications.prepare(s.collaborator_id,publishBody.id,randomUUID(),'normal','New request')).name,edited);
  assert.equal((await publishedList('')).json().items[0].settings,undefined);
  const managed = await api.inject({method:'GET',url:path+'?mine=true',headers:{authorization:'Bearer '+s.owner_token}});
  assert.deepEqual(managed.json().items[0].settings,{revision:2,normal_channel:s.channel_id,urgent_channel:s.channel_id});
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
