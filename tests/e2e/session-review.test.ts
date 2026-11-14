import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {chromium,expect} from '@playwright/test';
import {Pool} from 'pg';
import {conversationPath} from '@space/contracts';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {NavigatorStore} from '@space/postgres/navigator';
import {ChatStore} from '@space/postgres/chat';
import {PostgresStore} from '@space/postgres/store';
import {AgentSessionStore} from '@space/postgres/agent-sessions';
import {createApi} from '@space/server/api';
import {createAuthentication} from '@space/server/auth';

async function freePort():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return port;}
async function terminate(child:ChildProcess){if(child.exitCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}

test('a source message opens a code channel for reviewing artifacts, archiving, reopening and submitting feedback', {timeout:120_000}, async t=>{
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
  const address=await app.listen({host:'127.0.0.1',port:0});
  const webDirectory=fileURLToPath(new URL('../../apps/web',import.meta.url));
  vite=spawn('pnpm',['exec','vite','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{cwd:webDirectory,env:{...process.env,SPACE_API_URL:address},stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Vite startup timeout: '+output)),20000);vite!.stdout!.on('data',chunk=>{output+=chunk;if(stripVTControlCharacters(output).includes('Local:')){clearTimeout(timer);resolve();}});vite!.stderr!.on('data',chunk=>{output+=chunk;});vite!.once('exit',()=>{clearTimeout(timer);reject(new Error('Vite exited: '+output));});});
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1512,height:900},reducedMotion:'reduce'});
  const signup=await context.request.post(web+'/v1/auth/sign-up/email',{
    data:{name:'Release reviewer',email:'reviewer-'+schema+'@example.test',password:randomBytes(18).toString('hex')},
    headers:{origin:web},
  });
  assert.equal(signup.status(),200);
  const actor=(await signup.json()).user.id;
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[seed.workspace_id,actor]);
  await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)',[seed.workspace_id,seed.channel_id,actor]);
  await pool.query("UPDATE agent_definitions SET name='Codex', capabilities=capabilities||$2::jsonb WHERE id=$1",
    [seed.definition_id,{skills:['codex.run'],persistent_sessions:true}]);
  await pool.query("UPDATE agent_grants SET skill='codex.run' WHERE installation_id=$1",[seed.installation_id]);
  const sourceUrl='https://example.test/releases';
  const goal='@Codex Check the release before we ship. '+sourceUrl;
  await chat.send(actor,seed.channel_id,{thread_id:seed.thread_id,client_message_id:randomUUID(),text:goal,
    document:{ops:[{insert:'@Codex',attributes:{mention:{kind:'agent',id:seed.installation_id,label:'Codex'}}},{insert:' Check the release before we ship. '+sourceUrl+'\n'}]}});
  await pool.query('UPDATE navigator_threads SET available_at=now() WHERE thread_id=$1',[seed.thread_id]);
  assert.equal(await new NavigatorStore(pool).processOne(seed.thread_id),true);
  const {rows:[task]}=await pool.query('SELECT id,session_id FROM tasks WHERE thread_id=$1',[seed.thread_id]);
  assert.ok(task?.session_id,'The mention must create a managed code channel');
  const created=(await sessions.read(actor,task.session_id)).session;
  const session=await sessions.rename(actor,created.id,{title:'Release review',previous_title:created.title});
  await store.approveTask(seed.owner_id,task.id);
  const delivery=await store.claimDelivery();
  assert.ok(delivery);
  await store.prepareDelivery(delivery);
  const outputs={
    files:[],changes:[{path:'release.ts',patch:'@@ -1 +1 @@\n-export const channel = "beta";\n+export const channel = "stable";'}],
    context:{repository:{label:'space/app',url:'https://github.com/space/app'},base_branch:'main',head_branch:'release/stable',pull_request:{label:'PR #7',url:'https://github.com/space/app/pull/7'}},
    views:[
      {key:'coverage',name:'Coverage',type:'html',content:'<h1>Release coverage</h1><button onclick="document.querySelector(\'output\').textContent=18">Show passing checks</button><output></output>'},
      {key:'plan',name:'Plan',type:'canvas',content:'# Release checklist\nReview the default release channel.'},
      {key:'results',name:'Results',type:'blocks',blocks:[{id:'status',type:'card',title:'Release checks',body:'All checks passed.'}]},
    ],
  };
  for(const [i,type] of ['execution.started','execution.completed'].entries()) {
    await store.acceptEvent(seed.installation_id,{id:randomUUID(),schema_version:'1.0',execution_id:delivery.execution_id,sequence:i+1,type,occurred_at:new Date().toISOString(),payload:{text:i?'Review is ready':'Working',...(i?{response:{messages:[],tools:[],components:[],outputs}}:{})}},delivery);
  }
  await store.ackDelivery(delivery);
  const page=await context.newPage();
  const captures=process.env.SPACE_CODE_SCREENSHOTS;
  async function capture(name:string) {
    if(!captures)return;
    await mkdir(captures,{recursive:true});
    await page.screenshot({path:captures+'/'+name+'.png',animations:'disabled'});
  }
  await page.goto(web+'/chat?workspace='+seed.workspace_id+'&channel='+seed.channel_id);
  await expect(page.getByText(/Check the release before we ship/).first()).toBeVisible();
  await expect(page.getByText('Review is ready',{exact:true})).toBeVisible();
  const shortcut=page.getByRole('button',{name:'View changes',exact:true});
  await capture('source');
  await shortcut.click();
  const changes=page.getByRole('tabpanel',{name:'Code',exact:true});
  await expect(changes).toBeVisible();
  await expect(page.getByRole('button',{name:'Conversation details for Release review'})).toBeVisible();
  await expect(page.getByRole('link',{name:'View original conversation'})).toHaveAttribute('href',conversationPath(seed.channel_id,seed.thread_id)!);
  await expect(page.getByRole('link',{name:'space/app'})).toHaveAttribute('href','https://github.com/space/app');
  await expect(page.getByRole('link',{name:'PR #7'})).toHaveAttribute('href','https://github.com/space/app/pull/7');
  await expect(page.getByRole('textbox',{name:'Message agent session'})).toBeVisible();
  await capture('review');
  await page.setViewportSize({width:390,height:844});
  await expect(changes).toBeVisible();
  await capture('review-mobile');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile review must fit the viewport');
  await page.getByRole('button',{name:'Close artifacts'}).click();
  await expect(page.getByRole('textbox',{name:'Message agent session'})).toBeVisible();
  await page.getByRole('button',{name:/Artifacts 4/}).click();
  await expect(changes).toBeVisible();
  await page.setViewportSize({width:1512,height:900});
  await page.getByRole('tab',{name:'Files & links'}).click();
  await expect(page.getByRole('tabpanel',{name:'Files & links'}).locator('a').first()).toHaveAttribute('href',sourceUrl);
  await page.getByRole('tab',{name:'Coverage',exact:true}).click();
  await expect(page.frameLocator('iframe').getByRole('heading',{name:'Release coverage'})).toBeVisible();
  const coverage=page.frameLocator('iframe');
  await coverage.getByRole('button',{name:'Show passing checks'}).click();
  await expect(coverage.locator('output')).toHaveText('18');
  await page.getByRole('tab',{name:'Plan',exact:true}).click();
  await expect(page.getByText('Review the default release channel.',{exact:false})).toBeVisible();
  await page.getByRole('tab',{name:'Results',exact:true}).click();
  await expect(page.getByText('All checks passed.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'More conversation actions'}).click();
  await page.getByRole('menuitem',{name:'End session for everyone'}).click();
  await page.getByRole('dialog').getByRole('button',{name:'End session',exact:true}).click();
  const reopen=page.getByRole('button',{name:'Reopen session',exact:true});
  await expect(reopen).toBeVisible();
  await capture('archived');
  await reopen.click();
  await expect(page.getByRole('textbox',{name:'Message agent session'})).toBeVisible();
  await page.getByRole('tab',{name:'Code',exact:true}).click();
  await changes.getByRole('button',{name:/comment on release.ts, new line 1/i}).click();
  await changes.getByRole('textbox').fill('Cover the fallback release date.');
  await changes.getByRole('button',{name:'Add to review'}).click();
  await changes.getByRole('button',{name:'Submit review'}).click();
  const reviewMessage=changes.getByRole('textbox',{name:'Review message'});
  await expect(reviewMessage).toHaveValue(/Cover the fallback release date/);
  await reviewMessage.fill('Add a test for the fallback release date.');
  await capture('send-review');
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
  assert.match(feedback.goal,/Add a test for the fallback release date/);
  await expect(page.getByRole('textbox',{name:'Message agent session'})).toBeVisible();
});
