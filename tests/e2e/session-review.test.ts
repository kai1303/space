import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {chromium,expect} from '@playwright/test';
import {Pool} from 'pg';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {ChatStore} from '@space/postgres/chat';
import {PostgresStore} from '@space/postgres/store';
import {AgentSessionStore} from '@space/postgres/agent-sessions';
import {createApi} from '@space/server/api';
import {createAuthentication} from '@space/server/auth';

async function freePort():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return port;}
async function terminate(child:ChildProcess){if(child.exitCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}

test('the source result opens its exact review view and a teammate can submit anchored feedback', {timeout:120_000}, async t=>{
  const databaseUrl=process.env.TEST_DATABASE_URL;
  if(!databaseUrl) throw new Error('TEST_DATABASE_URL required');
  const schema='session_browser_'+randomBytes(6).toString('hex');
  const admin=new Pool({connectionString:databaseUrl});
  const scoped=new URL(databaseUrl);
  scoped.searchParams.set('options',`-c search_path=${schema}`);
  const pool=new Pool({connectionString:scoped.toString()});
  const store=new PostgresStore(pool),sessions=new AgentSessionStore(pool,store);
  const webPort=await freePort(),web=`http://127.0.0.1:${webPort}`;
  const auth=createAuthentication(pool,{secret:randomBytes(32).toString('hex'),baseURL:web});
  const app=createApi(store,{auth,realtime:{eventUrl:process.env.NATS_URL??'nats://127.0.0.1:54222'}});
  let vite:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  t.after(async()=>{
    await browser?.close(); if(vite)await terminate(vite); await app.close(); await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
  const seed=await bootstrap(pool),chat=new ChatStore(pool);
  await chat.send(seed.owner_id,seed.channel_id,{thread_id:seed.thread_id,client_message_id:randomUUID(),text:'Please check the release'});
  await pool.query("UPDATE agent_definitions SET capabilities=jsonb_set(capabilities,'{persistent_sessions}','true') WHERE id=$1",[seed.definition_id]);
  const session=await sessions.create(seed.owner_id,seed.thread_id,{client_session_id:randomUUID(),installation_id:seed.installation_id,skill:'demo.echo',title:'Release review'});
  const task=await sessions.send(seed.owner_id,session.id,{text:'Check the release'},randomUUID());
  await pool.query('INSERT INTO messages(id,workspace_id,channel_id,thread_id,task_id,installation_id,agent_session_id,text) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),seed.workspace_id,seed.channel_id,seed.thread_id,task.id,seed.installation_id,session.id,session.title]);
  const delivery=await store.claimDelivery();
  assert.ok(delivery);await store.prepareDelivery(delivery);
  const outputs={files:[],changes:[{path:'release.ts',patch:'@@ -1 +1 @@\n-old\n+release'}]};
  for(const [i,type] of ['execution.started','execution.completed'].entries()) {
    await store.acceptEvent(seed.installation_id,{id:randomUUID(),schema_version:'1.0',execution_id:delivery.execution_id,sequence:i+1,type,occurred_at:new Date().toISOString(),payload:{text:i?'Review is ready':'Working',...(i?{response:{messages:[],tools:[],components:[],outputs}}:{})}},delivery);
  }
  await store.ackDelivery(delivery);
  const address=await app.listen({host:'127.0.0.1',port:0});
  const webDirectory=fileURLToPath(new URL('../../apps/web',import.meta.url));
  vite=spawn('pnpm',['exec','vite','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{cwd:webDirectory,env:{...process.env,SPACE_API_URL:address},stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Vite startup timeout: '+output)),20000);vite!.stdout!.on('data',chunk=>{output+=chunk;if(stripVTControlCharacters(output).includes('Local:')){clearTimeout(timer);resolve();}});vite!.stderr!.on('data',chunk=>{output+=chunk;});vite!.once('exit',()=>{clearTimeout(timer);reject(new Error('Vite exited: '+output));});});
  browser=await chromium.launch({headless:true});
  async function openMember(name:string) {
    const context=await browser!.newContext({viewport:{width:1280,height:800}});
    const signup=await context.request.post(web+'/v1/auth/sign-up/email',{data:{name,email:name+'-'+schema+'@example.test',password:randomBytes(18).toString('hex')},headers:{origin:web}});
    assert.equal(signup.status(),200);
    const actor=(await signup.json()).user.id;
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[seed.workspace_id,actor]);
    await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)',[seed.workspace_id,seed.channel_id,actor]);
    const page=await context.newPage();
    await page.goto(web+'/chat?workspace='+seed.workspace_id+'&channel='+seed.channel_id);
    await expect(page.getByText('Please check the release',{exact:true})).toBeVisible();
    return page;
  }

  const page=await openMember('reviewer');
  await expect(page.getByText('Review is ready',{exact:true})).toBeVisible();
  const shortcut=page.getByRole('button',{name:'View changes',exact:true});
  await shortcut.click();
  const changes=page.getByRole('tabpanel',{name:'Changes',exact:true});
  await expect(changes).toBeVisible();
  await changes.getByRole('button',{name:/comment on release.ts, new line 1/i}).click();
  await changes.getByRole('textbox').fill('Cover the fallback release date.');
  await changes.getByRole('button',{name:'Add to review'}).click();
  const queued=page.waitForResponse(response=>response.url().endsWith('/agent-sessions/'+session.id+'/queue') && response.request().method()==='POST');
  await changes.getByRole('button',{name:'Send review'}).click();
  const response=await queued;
  assert.ok(response.ok(),await response.text());
  const {id:inputId}=await response.json();
  await sessions.drainQueue(session.id);
  const {rows:[feedback]}=await pool.query<{status:string;goal:string}>(
    'SELECT t.status,t.goal FROM agent_session_inputs i JOIN tasks t ON t.id=i.task_id WHERE i.session_id=$1 AND i.id=$2',
    [session.id,inputId],
  );
  assert.equal(feedback?.status,'awaiting_approval');
  assert.match(feedback.goal,/release.ts · new line 1/);
  assert.match(feedback.goal,/Cover the fallback release date/);
  await expect(page.getByRole('tablist',{name:'Session views'}).getByRole('tab',{name:'Messages',exact:true})).toHaveAttribute('aria-selected','true');
  await shortcut.click();
  await expect(changes).toBeVisible();
});
