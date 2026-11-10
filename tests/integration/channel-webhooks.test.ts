import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApi } from '@space/server/api';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { ChatStore } from '@space/postgres/chat';

test('scoped incoming webhook, concurrent retry, app attribution and revocation', async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  const schema = 'hooks_' + randomBytes(8).toString('hex');
  const admin = new Pool({connectionString:url});
  const pool = new Pool({connectionString:url, options:'-c search_path=' + schema});
  const app = createApi(new PostgresStore(pool), { allowDevelopmentTokens:true });
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    await migrate(pool);
    const fixture = await bootstrap(pool);
    const chat = new ChatStore(pool);
    const channel = await chat.createChannel(fixture.owner_id, fixture.workspace_id, {name:'builds', private:true});
    await chat.addMember(fixture.owner_id, channel.id, {user_id:fixture.collaborator_id});
    const owner = {authorization:'Bearer ' + fixture.owner_token};
    const member = {authorization:'Bearer ' + fixture.collaborator_token};
    const endpoint = '/v1/channels/' + channel.id + '/webhooks';
    const create = (headers: Record<string,string>) => app.inject({method:'POST',url:endpoint,headers,payload:{name:'Build Bot'}});
    assert.equal((await create(member)).statusCode,403);
    const created = await create(owner);
    assert.equal(created.statusCode,201,created.body);
    const hook = created.json();
    const hooks = await app.inject({method:'GET',url:endpoint,headers:owner});
    assert.deepEqual(hooks.json(), [{id:hook.id,name:'Build Bot'}]);
    const post = (text: string) => app.inject({method:'POST',url:hook.path,headers:{'idempotency-key':'build-482'},payload:{text}});
    const results = await Promise.all([post('Build passed'), post('Build passed')]);
    for (const response of results) assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(results[0]!.json(),results[1]!.json());
    assert.equal((await post('Different build')).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:hook.path,payload:{text:'Hi',channel_id:fixture.channel_id}})).statusCode,400);
    assert.equal((await app.inject({method:'DELETE',url:endpoint+'/'+hook.id,headers:member})).statusCode,403);
    assert.equal((await app.inject({method:'DELETE',url:endpoint+'/'+hook.id,headers:owner})).statusCode,204);
    assert.equal((await post('Build passed')).statusCode,404);
    const history = await app.inject({method:'GET',url:'/v1/channels/'+channel.id+'/history',headers:member});
    assert.equal(history.statusCode,200);
    const {rows} = await pool.query('SELECT payload FROM channel_events WHERE channel_id=$1 AND type=$2',[channel.id,'message.created']);
    assert.equal(rows.length,1);
    assert.deepEqual(rows[0].payload.author,{kind:'app',id:hook.id,name:'Build Bot'});
    assert.ok(history.body.includes('Build Bot'));
  } finally {
    await app.close(); await pool.end(); await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end();
  }
});
