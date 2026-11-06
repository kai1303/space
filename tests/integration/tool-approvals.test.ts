import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {AgentSessionStore} from '@space/postgres/agent-sessions';
import {PostgresStore} from '@space/postgres/store';
import {ToolApprovalStore} from '@space/postgres/tool-approvals';

const schema=`tool_approvals_${randomBytes(6).toString('hex')}`;
const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required');
const admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const tasks=new PostgresStore(pool),sessions=new AgentSessionStore(pool,tasks);
const approvals=new ToolApprovalStore(pool);
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function fixture(){
 const a=await bootstrap(pool),connection=randomUUID();
 await pool.query('UPDATE agent_definitions SET capabilities=$2 WHERE id=$1',[a.definition_id,{skills:['codex.run'],controls:{},persistent_sessions:true}]);
 await pool.query("UPDATE agent_installations SET connector_id='codex.legacy-test' WHERE id=$1",[a.installation_id]);
 await pool.query("INSERT INTO agent_connections(installation_id,name,connection_id,auth_status,last_seen_at) VALUES($1,'Coding agent',$2,'ready',now())",[a.installation_id,connection]);
 const session=await sessions.create(a.owner_id,a.thread_id,{client_session_id:randomUUID(),installation_id:a.installation_id,title:'Coding test',skill:'codex.run'});
 const task=await sessions.send(a.owner_id,session.id,{text:'Update README'},randomUUID());
 const delivery=(await tasks.claimDelivery(a.installation_id))!;
 await tasks.prepareDelivery(delivery,connection);
 await pool.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 return {...a,connection,session,task,delivery};
}
test('session detail includes reloadable tool approval state',async()=>{
 const a=await fixture();
 const detail=await sessions.read(a.owner_id,a.session.id);
 assert.deepEqual((detail as any).tool_approvals,[]);
 assert.match(detail.audience??'',/^Members of #/);
});
test('approval requests persist, reject changed retries, and only their owner can decide',async()=>{
 const a=await fixture(),input={id:randomUUID(),kind:'command',title:'Run tests',details:'pnpm test'};
 const request=()=>approvals.request(a.installation_id,a.connection,a.task.id,a.delivery.execution_id,input);
 assert.equal((await request()).status,'pending');
 assert.equal((await request()).status,'pending');
 assert.equal((await sessions.read(a.owner_id,a.session.id)).tool_approvals?.[0]?.title,'Run tests');
 await assert.rejects(approvals.request(a.installation_id,a.connection,a.task.id,a.delivery.execution_id,{...input,details:'git push'}),/idempotency_conflict/);
 await assert.rejects(approvals.decide(a.collaborator_id,a.session.id,input.id,{decision:'allow'}),/tool_approval_owner_required/);
 await assert.rejects(approvals.request(a.installation_id,randomUUID(),a.task.id,a.delivery.execution_id,{...input,id:randomUUID()}),/stale_execution/);
 await approvals.decide(a.owner_id,a.session.id,input.id,{decision:'allow'});
 assert.equal((await approvals.decision(input.id))?.status,'allow');
 assert.equal(await approvals.consume(a.installation_id,a.connection,input.id),'allow');
 assert.ok((await sessions.read(a.owner_id,a.session.id)).tool_approvals?.[0]?.consumed_at);
 assert.equal(await approvals.decision(input.id),undefined);
 await assert.rejects(approvals.decide(a.owner_id,a.session.id,input.id,{decision:'deny'}),/tool_approval_resolved/);
});
test('conflicting decisions have one winner and stopping cancels pending approval authority',async()=>{
 const a=await fixture(),input={id:randomUUID(),kind:'project',title:'Use local project',details:'/tmp/project'};
 await approvals.request(a.installation_id,a.connection,a.task.id,a.delivery.execution_id,input);
 const decisions=await Promise.allSettled(['allow','deny'].map(decision=>approvals.decide(a.owner_id,a.session.id,input.id,{decision})));
 assert.equal(decisions.filter(result=>result.status==='fulfilled').length,1);
 const pending={...input,id:randomUUID()};
 await approvals.request(a.installation_id,a.connection,a.task.id,a.delivery.execution_id,pending);
 await sessions.control(a.owner_id,a.session.id,'stop');
 await assert.rejects(approvals.decide(a.owner_id,a.session.id,pending.id,{decision:'allow'}),/stale_execution/);
 assert.equal((await sessions.read(a.owner_id,a.session.id)).tool_approvals?.find(p=>p.id===pending.id)?.status,'cancelled');
});
