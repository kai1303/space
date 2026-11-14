import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { PostgresStore } from '@space/postgres/store';
import { ChatStore } from '@space/postgres/chat';
import { FoundationStore } from '@space/postgres/foundation';
import { readSessionReports } from '@space/postgres/session-reports';
import { AgentSessionStore } from '@space/postgres/agent-sessions';
import { AgUiConnector } from '@space/core/ag-ui';
import { deliverOne } from '@space/core/worker';
import type { AgentEvent, AgentResponse } from '@space/contracts';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const schema = `test_ag_ui_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const store = new PostgresStore(pool), chat = new ChatStore(pool);
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => { await pool.query('DELETE FROM outbox'); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('an approved AG-UI installation executes through the worker and saves a rich reply', async () => {
  const seed = await bootstrap(pool), foundation = new FoundationStore(pool);
  const definition = await foundation.publishDefinition({ name: 'AG-UI test agent', capabilities: { skills: ['ag-ui.run'], controls: { progress_stream: true } } });
  const installation = await foundation.install(seed.owner_id, { workspace_id: seed.workspace_id, definition_id: definition.id, connector_id: 'ag-ui' });
  await foundation.grant(seed.owner_id, installation.id, { channel_id: seed.channel_id, skill: 'ag-ui.run' });
  const task = await store.createTask(seed.owner_id, { workspace_id: seed.workspace_id, thread_id: seed.thread_id, installation_id: installation.id, skill: 'ag-ui.run', goal: 'Review results' }, randomUUID());
  await store.approveTask(seed.owner_id, task.id);
  const carousel = { type: 'carousel', id: 'options', title: 'Next steps', cards: [
    { id: 'small', title: 'Pilot', body: 'One team' }, { id: 'large', title: 'Expand', body: 'All teams' },
  ] };
  const dataTable = { type: 'data_table', id: 'plans', title: 'Customers', columns: ['Plan', 'Count'], rows: [['Pro', 12], ['Starter', 2]] };
  const alert = { type: 'alert', id: 'stale', level: 'warning', title: 'Cached results' };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'RUN_STARTED', runId: input.runId, threadId: input.threadId },
      { type: 'CUSTOM', name: 'space.ui', value: alert },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm', role: 'assistant', delta: '**Saved result**' },
      { type: 'CUSTOM', name: 'space.ui', value: { id: 'c', type: 'card', title: 'Result', body: 'Ready for review' } },
      { type: 'CUSTOM', name: 'space.ui', value: { ...carousel, cards: carousel.cards.slice(0, 1) } },
      { type: 'CUSTOM', name: 'space.ui', value: carousel },
      { type: 'CUSTOM', name: 'space.ui', value: { ...dataTable, rows: [] } },
      { type: 'CUSTOM', name: 'space.ui', value: dataTable },
      { type: 'RUN_FINISHED', runId: input.runId, threadId: input.threadId },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    assert.equal(await deliverOne(store, [new AgUiConnector({ url: `http://127.0.0.1:${address.port}` })]), true);
    assert.equal((await store.readTask(seed.owner_id, task.id)).status, 'completed');
    const page = await chat.messageHistory(seed.owner_id, seed.channel_id);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0]?.agent_response?.messages[0]?.text, '**Saved result**');
    assert.deepEqual(page.messages[0]?.agent_response?.components[0], alert);
    assert.equal(page.messages[0]?.agent_response?.components[1]?.title, 'Result');
    assert.deepEqual(page.messages[0]?.agent_response?.components.slice(2), [carousel, dataTable]);
    const history = await chat.history(seed.owner_id, seed.channel_id);
    const progress = history.events.filter(e => e.type === 'task.event' && e.payload.type === 'execution.progress');
    assert.ok(progress.some(e => e.type === 'task.event' && e.payload.data.channel_post_author === 'AG-UI test agent'));
    assert.deepEqual(page.messages[0]?.agent_response?.items?.[0], { type: 'component', id: alert.id });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a terminal delivery failure retains partial response content', async () => {
  const seed = await bootstrap(pool);
  const task = await store.createTask(seed.owner_id, { workspace_id: seed.workspace_id, thread_id: seed.thread_id, installation_id: seed.installation_id, goal: 'Review results', skill: 'demo.echo' }, randomUUID());
  const approved = await store.approveTask(seed.owner_id, task.id);
  const delivery = await store.claimDelivery();
  assert.ok(delivery);
  const response: AgentResponse = { activity: 'using_tools', messages: [{ id: 'm', text: 'Partial result', status: 'streaming' }], tools: [{ id: 't', name: 'search', arguments: '{}', status: 'running' }], components: [], items: [{ type: 'message', id: 'm' }, { type: 'tool', id: 't' }] };
  await store.acceptEvent(seed.installation_id, { id: randomUUID(), execution_id: approved.active_execution_id!, schema_version: '1.0', sequence: 1, type: 'execution.started', occurred_at: '2026-11-03T00:00:00.000Z', payload: { text: 'Working', response } });
  await store.failDelivery(delivery, 'connector_timeout', true);
  const events = await store.events(seed.owner_id, task.id, 0);
  const {activity: _activity, ...terminal} = response;
  assert.deepEqual(events.at(-1)?.payload.response, { ...terminal, messages: [{ ...response.messages[0], status: 'complete' }], tools: [{ ...response.tools[0], status: 'interrupted' }] });
});

test('structured responses persist once and survive message history and task replay', async () => {
  const seed = await bootstrap(pool);
  const task = await store.createTask(seed.owner_id, { workspace_id: seed.workspace_id, thread_id: seed.thread_id, installation_id: seed.installation_id, goal: 'Review results', skill: 'demo.echo' }, randomUUID());
  const approved = await store.approveTask(seed.owner_id, task.id);
  const response: AgentResponse = { messages: [{ id: 'm', text: '**Results**', status: 'complete' }], tools: [], components: [{ id: 'card', type: 'card', title: 'Churn', body: 'Down 2%' }] };
  const event = (sequence: number, type: AgentEvent['type']): AgentEvent => ({ id: randomUUID(), execution_id: approved.active_execution_id!, schema_version: '1.0', sequence, type, occurred_at: '2026-11-03T00:00:00.000Z', payload: { text: 'Results', response } });
  await store.acceptEvent(seed.installation_id, event(1, 'execution.started'));
  const progress = event(2, 'execution.progress');
  await store.acceptEvent(seed.installation_id, progress);
  await store.acceptEvent(seed.installation_id, progress);
  const completed = event(3, 'execution.completed');
  await store.acceptEvent(seed.installation_id, completed);
  await store.acceptEvent(seed.installation_id, completed);
  const page = await chat.messageHistory(seed.owner_id, seed.channel_id);
  assert.equal(page.messages.length, 1);
  assert.deepEqual(page.messages[0]?.agent_response, response);
  const replay = await chat.history(seed.owner_id, seed.channel_id);
  const created = replay.events.find(event => event.type === 'message.created');
  assert.ok(created?.type === 'message.created');
  assert.deepEqual(created.payload.agent_response, response);
  assert.deepEqual(replay.events.at(-1)?.payload, { task_id: task.id, type: 'task.completed', actor_id: seed.installation_id, installation_id: seed.installation_id, owner_id: seed.owner_id, data: { result: 'Results', response } });
  assert.deepEqual((await chat.threadHistory(seed.owner_id, seed.thread_id)).messages[0]?.agent_response, response);
});

test('interleaved response order survives persistence, duplicate receipts and thread replay',async()=>{
 const seed=await bootstrap(pool);
 const task=await store.createTask(seed.owner_id,{workspace_id:seed.workspace_id,thread_id:seed.thread_id,installation_id:seed.installation_id,goal:'Ordered turn',skill:'demo.echo'},randomUUID());
 const approved=await store.approveTask(seed.owner_id,task.id);
 const response:AgentResponse={messages:[{id:'before',text:'Before.',status:'complete'},{id:'between',text:'Between.',status:'complete'},{id:'final',text:'Final.',status:'complete'}],tools:[{id:'first',name:'read_text_file',arguments:'{}',result:'First result',status:'completed'},{id:'second',name:'read_text_file',arguments:'{}',result:'Second result',status:'completed'}],components:[],items:[{type:'message',id:'before'},{type:'tool',id:'first'},{type:'message',id:'between'},{type:'tool',id:'second'},{type:'message',id:'final'}]};
 const event=(sequence:number,type:AgentEvent['type'],snapshot?:AgentResponse):AgentEvent=>({id:randomUUID(),execution_id:approved.active_execution_id!,schema_version:'1.0',sequence,type,occurred_at:new Date().toISOString(),payload:{text:'Ordered turn',...(snapshot?{response:snapshot}:{})}});
 await store.acceptEvent(seed.installation_id,event(1,'execution.started'));
 const completed=event(2,'execution.completed',response);await store.acceptEvent(seed.installation_id,completed);await store.acceptEvent(seed.installation_id,completed);
 const history=await chat.threadHistory(seed.owner_id,seed.thread_id);
 assert.equal(history.messages.length,1);assert.deepEqual(history.messages[0]?.agent_response,response);
 const replay=await chat.history(seed.owner_id,seed.channel_id);
 const message=replay.events.find(event=>event.type==='message.created');assert.ok(message?.type==='message.created');assert.deepEqual(message.payload.agent_response?.items,response.items);
});

test('an installed persistent backend opens a task session, publishes results and archives it on successful finish', async () => {
  const seed = await bootstrap(pool), foreign = await bootstrap(pool);
  const foundation = new FoundationStore(pool);
  const source = await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),thread_id:seed.thread_id,text:'Please review the release'});
  const definition = await foundation.publishDefinition({name:'Release reviewer',capabilities:{persistent_sessions:true,skills:['ag-ui.run'],controls:{progress_stream:true}}});
  const installation = await foundation.install(seed.owner_id,{workspace_id:seed.workspace_id,definition_id:definition.id,connector_id:'ag-ui'});
  await foundation.grant(seed.owner_id,installation.id,{channel_id:seed.channel_id,skill:'ag-ui.run'});
  const task = await store.createTask(seed.owner_id,{workspace_id:seed.workspace_id,thread_id:seed.thread_id,installation_id:installation.id,skill:'ag-ui.run',goal:'Review the release'},randomUUID());
  const approved = await store.approveTask(seed.owner_id,task.id);
  const context = {repository:{label:'example/project',url:'https://github.com/example/project'},base_branch:'main',head_branch:'release'};
  const plan = {key:'plan',name:'Plan',type:'canvas',content:'# Plan'};
  const preview = {key:'coverage',name:'Coverage',type:'html',content:'<h1>Coverage</h1>'};
  const server = createServer(async (req,res) => {
    let body=''; for await (const chunk of req) body+=chunk;
    const {runId,threadId}=JSON.parse(body);
    res.writeHead(200,{'content-type':'text/event-stream'});
    for (const data of [
      {type:'RUN_STARTED',runId,threadId},
      {type:'CUSTOM',name:'space.session.open',value:{}},
      {type:'CUSTOM',name:'space.session.outputs',value:{context,views:[plan,preview],files:[],changes:[{path:'README.md',patch:'@@ -1 +1 @@\n-old\n+release'}],actions:[{label:'Open pull request',url:'https://github.com/example/project/pull/12'}]}},
      {type:'CUSTOM',name:'space.session.setView',value:{...plan,content:'# Final plan'}},
      {type:'CUSTOM',name:'space.session.removeView',value:{key:'coverage'}},
      {type:'CUSTOM',name:'space.session.setView',value:{key:'checks',name:'Checks',type:'blocks',blocks:[]}},
      {type:'TEXT_MESSAGE_CHUNK',messageId:'m',role:'assistant',delta:'Ready for review'},
      {type:'CUSTOM',name:'space.session.archive',value:{}},
      {type:'RUN_FINISHED',runId,threadId}
    ]) res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address(); assert.ok(address && typeof address!=='string');
    const backend=new AgUiConnector({url:`http://127.0.0.1:${address.port}`});
    await deliverOne(store,[{id:backend.id,discover:()=>backend.discover(),
      invoke:(input,emit,signal)=>backend.invoke(input,async raw=>{
        await emit(raw);
        if ((raw as AgentEvent).payload.session_lifecycle==='archive' || (raw as AgentEvent).payload.session_view) await emit(raw);
      },signal)}]);
    assert.equal((await store.readTask(seed.owner_id,task.id)).status,'completed');
    assert.equal((await pool.query('SELECT state FROM outbox WHERE task_id=$1',[task.id])).rows[0]?.state,'done');
    const detail=await new AgentSessionStore(pool).read(seed.owner_id,approved.session_id!);
    assert.equal(detail.session.state,'ended'); assert.equal(detail.outputs?.changes[0]?.path,'README.md');
    assert.equal(detail.outputs?.actions?.[0]?.label,'Open pull request');
    assert.deepEqual(detail.outputs?.context,context);
    assert.deepEqual(detail.outputs?.views,[{...plan,content:'# Final plan'},{key:'checks',name:'Checks',type:'blocks',blocks:[]}]);
    const {items}=await readSessionReports(store.db,seed.collaborator_id,seed.channel_id,{threads:[seed.thread_id,foreign.thread_id]});
    assert.equal(items.length,1); assert.equal(items[0]?.id,approved.session_id); assert.equal(items[0]?.source_message_id,source.id); assert.equal(items[0]?.result,'Ready for review');
    assert.equal(items[0]?.artifact,'changes'); assert.equal(items[0]?.status,'archived');
    await assert.rejects(readSessionReports(store.db,foreign.owner_id,seed.channel_id,{threads:[seed.thread_id]}),/not_found/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
