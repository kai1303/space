import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {chromium,expect} from '@playwright/test';
import {Pool} from 'pg';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {ChatStore} from '@space/postgres/chat';
import {PostgresStore} from '@space/postgres/store';
import {EventBridge} from '@space/event-service/bridge';
import {createApi} from '@space/server/api';
import {createAuthentication} from '@space/server/auth';
import {TypesenseSearch} from '@space/server/typesense';

async function freePort():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return port;}
async function terminate(child:ChildProcess){if(child.exitCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}

test('browser searches actual Typesense across history, channels and replies with access enforcement', {timeout:150_000}, async t=>{
  const databaseUrl=process.env.TEST_DATABASE_URL;if(!databaseUrl)throw new Error('TEST_DATABASE_URL required');
  const schema=`search_browser_${randomBytes(6).toString('hex')}`;
  const admin=new Pool({connectionString:databaseUrl});
  const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema}`);
  const pool=new Pool({connectionString:scoped.toString()});
  const natsUrl=process.env.NATS_URL??'nats://127.0.0.1:54222';
  const config={url:process.env.TYPESENSE_URL??'http://127.0.0.1:58108',apiKey:process.env.TYPESENSE_API_KEY??'space_local_search',collection:schema};
  const engine=new TypesenseSearch(config),bridge=new EventBridge({databaseUrl:scoped.toString(),natsUrl,schema});
  const webPort=await freePort(),web=`http://127.0.0.1:${webPort}`;
  const auth=createAuthentication(pool,{secret:randomBytes(32).toString('hex'),baseURL:web});
  const app=createApi(new PostgresStore(pool),{auth,search:config,realtime:{eventUrl:natsUrl}});
  let vite:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  t.after(async()=>{
    await browser?.close();if(vite)await terminate(vite);await app.close();await bridge.close();await engine.removeCollection().catch(()=>{});await pool.end();
    await admin.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1',[bridge.slot]);
    await admin.query(`DROP PUBLICATION IF EXISTS "${bridge.publication}"`);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await engine.initialize();await bridge.start();
  const seed=await bootstrap(pool),outsider=await bootstrap(pool),chat=new ChatStore(pool);
  const old=await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:'Old browserneedle deployment message README.md'});
  for(let i=0;i<60;i++)await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:`Recent message ${i}`});
  const second=await chat.createChannel(seed.owner_id,seed.workspace_id,{name:'search-engineering',private:false});
  const root=await chat.send(seed.owner_id,second.id,{client_message_id:randomUUID(),text:'Crosschannelneedle deployment discussion'});
  const reply=await chat.send(seed.owner_id,second.id,{client_message_id:randomUUID(),thread_id:root.thread_id,text:'Replybrowserneedle answer in a thread'});
  const hidden=await chat.createChannel(seed.owner_id,seed.workspace_id,{name:'secret-search',private:true});
  await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:'Filterbrowserneedle docs https://example.test/help'});
  await chat.send(seed.owner_id,hidden.id,{client_message_id:randomUUID(),text:'Privateneedle confidential'});
  await chat.send(outsider.owner_id,outsider.channel_id,{client_message_id:randomUUID(),text:'Otherworkspaceneedle confidential'});
  const address=await app.listen({host:'127.0.0.1',port:0});
  const webDirectory=fileURLToPath(new URL('../../apps/web',import.meta.url));
  vite=spawn('pnpm',['exec','vite','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{cwd:webDirectory,env:{...process.env,SPACE_API_URL:address},stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Vite startup timeout: '+output)),20000);vite!.stdout!.on('data',chunk=>{output+=chunk;if(stripVTControlCharacters(output).includes('Local:')){clearTimeout(timer);resolve();}});vite!.stderr!.on('data',chunk=>{output+=chunk;});vite!.once('exit',()=>{clearTimeout(timer);reject(new Error('Vite exited: '+output));});});
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const signup=await context.request.post(`${web}/v1/auth/sign-up/email`,{data:{name:'Search browser user',email:`${schema}@example.test`,password:randomBytes(18).toString('hex')},headers:{origin:web}});
  assert.equal(signup.status(),200,await signup.text());const actor=(await signup.json()).user.id;
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[seed.workspace_id,actor]);
  await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3),($1,$4,$3)',[seed.workspace_id,seed.channel_id,actor,second.id]);
  // Test-only readiness: production search never polls while the durable index catches up.
  for(const [query,messageId] of [['browserneedle',old.id],['crosschannelneedle',root.id],['replybrowserneedle is:thread',reply.id]]) {
    await expect.poll(async()=>{
      const response=await context.request.get(`${web}/v1/workspaces/${seed.workspace_id}/search`,{params:{q:query!}});
      if(!response.ok())return false;
      return (await response.json()).items.some((item:{id:string})=>item.id===messageId);
    },{timeout:20000,intervals:[250,500,1000],message:`Search fixture indexed: ${query}`}).toBe(true);
  }
  await expect.poll(async()=>{
    let cursor:string|undefined;const ids=new Set<string>();
    for(let index=0;index<3;index++){
      const response=await context.request.get(`${web}/v1/workspaces/${seed.workspace_id}/search`,{params:{q:'Recent message',...(cursor?{cursor}:{})}});
      if(!response.ok())return ids.size;
      const page=await response.json();for(const item of page.items)ids.add(item.id);
      cursor=page.next_cursor??undefined;if(!cursor)break;
    }
    return ids.size;
  },{timeout:20000,intervals:[250,500,1000],message:'All pagination fixtures indexed'}).toBe(60);
  const page=await context.newPage();const browserErrors:string[]=[];page.on('pageerror',error=>browserErrors.push(error.message));
  await page.goto(`${web}/chat?workspace=${seed.workspace_id}&channel=${seed.channel_id}`);
  await expect(page.getByRole('button',{name:'Search in general',exact:true})).toBeVisible({timeout:20000});
  assert.ok(!(await chat.messageHistory(actor,seed.channel_id)).messages.some(m=>m.id===old.id),'fixture must exclude old result from loaded history');
  async function search(q:string,channel=false){
    await page.getByRole('button',{name:channel?'Search in general':/^Search General/ ,exact:channel}).click();
    const dialog=page.getByRole('dialog',{name:channel?'Search in general':'Search workspace',exact:true});
    const field=dialog.getByRole('searchbox',{name:'Search messages',exact:true});
    await field.fill(q);
    await expect(dialog.getByRole('button',{name:`Show results for: ${q}`,exact:true})).toBeVisible();
    await expect(dialog.getByRole('list',{name:'Search results'})).toHaveCount(0);
    await field.press('Enter');return channel ? page.getByRole('complementary',{name:'Search results in general'}) : dialog;
  }
  let dialog=await search('browserneedle');
  await expect(dialog.getByRole('button',{name:/Old browserneedle deployment message/})).toBeVisible({timeout:20000});
  await mkdir(fileURLToPath(new URL('../test-results/',import.meta.url)),{recursive:true});
  await page.screenshot({path:fileURLToPath(new URL('../test-results/typesense-search.png',import.meta.url)),fullPage:true});
  await expect(dialog.locator('mark')).toHaveText('browserneedle');
  await dialog.getByRole('button',{name:/Old browserneedle deployment message/}).click();
  let source=page.getByRole('dialog',{name:'Original message in #general',exact:true});
  await expect(source.getByText('Old browserneedle deployment message README.md',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  dialog=await search('crosschannelneedle');await expect(dialog.getByRole('button',{name:/Crosschannelneedle/})).toBeVisible();await dialog.getByRole('button',{name:/Crosschannelneedle/}).click();
  source=page.getByRole('dialog',{name:'Original message in #search-engineering',exact:true});await expect(source.getByText('Crosschannelneedle deployment discussion',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  dialog=await search('replybrowserneedle is:thread');await expect(dialog.getByRole('button',{name:/Replybrowserneedle/})).toBeVisible();await dialog.getByRole('button',{name:/Replybrowserneedle/}).click();
  source=page.getByRole('dialog',{name:'Original message in #search-engineering',exact:true});
  await expect(source.getByText('Replybrowserneedle answer in a thread',{exact:true})).toBeVisible();
  await page.evaluate(() => {
    const state = window as unknown as {searchDialogEvents:unknown[]}; state.searchDialogEvents=[];
    for(const type of ['keydown','cancel','close']) document.addEventListener(type,event=>{
      queueMicrotask(()=>state.searchDialogEvents.push({type,key:(event as KeyboardEvent).key,prevented:event.defaultPrevented,target:(event.target as HTMLElement)?.tagName,heading:(event.target as HTMLElement)?.closest('dialog')?.querySelector('h2')?.textContent}));
    },true);
  });
  await page.keyboard.press('Escape');
  try { await expect(source).toBeHidden({timeout:3000}); }
  catch(error) {
    t.diagnostic(JSON.stringify(await page.evaluate(()=>({events:(window as unknown as {searchDialogEvents:unknown[]}).searchDialogEvents,focused:document.activeElement?.outerHTML,dialogs:[...document.querySelectorAll('dialog')].map(dialog=>({open:dialog.open,inert:dialog.inert,heading:dialog.querySelector('h2')?.textContent}))}))));
    await page.screenshot({path:fileURLToPath(new URL('../test-results/typesense-reply-escape.png',import.meta.url)),fullPage:true});
    throw error;
  }
  dialog=await search('privateneedle');await expect(dialog.getByText('No messages found',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  try { await expect(dialog).toBeHidden({timeout:3000}); } catch(error) { t.diagnostic(JSON.stringify(await page.evaluate(()=>({events:(window as unknown as {searchDialogEvents:unknown[]}).searchDialogEvents,focused:document.activeElement?.outerHTML,dialogs:[...document.querySelectorAll('dialog[open]')].map(dialog=>dialog.querySelector('h2')?.textContent)})))); throw error; }
  dialog=await search('otherworkspaceneedle');await expect(dialog.getByText('No messages found',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await page.goto(`${web}/chat?workspace=${seed.workspace_id}&channel=${seed.channel_id}`);
  await expect(page.getByRole('button',{name:'Search in general',exact:true})).toBeVisible();
  dialog=await search('README',true);
  const match=dialog.getByRole('button',{name:/Old browserneedle deployment message README.md/});
  await match.click();
  await expect(page.getByRole('region',{name:'Original message in #general'})).toContainText('README.md');
  await expect(match).toBeVisible();
  await page.getByRole('button',{name:/^in:general README/}).click();
  const edit=page.getByRole('searchbox',{name:'Search messages'});
  await expect(edit).toBeFocused();
  await expect(edit).toHaveValue('README');
  await edit.press('Escape');
  await expect(match).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  const conversationBounds=await page.getByRole('main').boundingBox(), resultsBounds=await dialog.boundingBox();
  assert.ok(conversationBounds && resultsBounds && resultsBounds.y >= conversationBounds.y + conversationBounds.height - 1);
  assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1));
  await page.setViewportSize({width:1440,height:1000});
  await dialog.getByRole('button',{name:'Close search results'}).click();
  dialog=await search('crosschannelneedle',true);await expect(dialog.getByText('No messages found',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  dialog=await search('Recent message');await expect(dialog.getByRole('list',{name:'Search results'}).getByRole('button')).toHaveCount(20);await dialog.getByRole('button',{name:'Load more results',exact:true}).click();await expect(dialog.getByRole('list',{name:'Search results'}).getByRole('button')).toHaveCount(40);
  await page.keyboard.press('Escape');
  dialog=await search('Filterbrowserneedle');
  const filterResult=dialog.getByRole('button',{name:/Filterbrowserneedle docs/});
  await expect(filterResult).toBeVisible();
  await dialog.getByRole('button',{name:'Has a link',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Has a link',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(filterResult).toBeVisible();
  await dialog.getByRole('button',{name:'Threads only',exact:true}).click();
  await expect(dialog.getByText('No messages found',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Threads only',exact:true}).click();
  await expect(filterResult).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await expect(dialog.getByRole('searchbox')).toBeVisible();
  assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'search dialog must not overflow on mobile');
  await page.screenshot({path:fileURLToPath(new URL('../test-results/typesense-search-mobile.png',import.meta.url)),fullPage:true});
  await page.keyboard.press('Escape');
  assert.deepEqual(browserErrors,[]);
  t.diagnostic(`Real browser verified message ${old.id}, cross-channel ${root.id}, reply ${reply.id}; screenshot tests/test-results/typesense-search.png`);
});
