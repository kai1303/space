import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium,expect,type Page,type BrowserContext} from '@playwright/test';
import {Pool} from 'pg';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {ChatStore} from '@space/postgres/chat';
import {PostgresStore} from '@space/postgres/store';
import {EventBridge} from '@space/event-service/bridge';
import {createApi} from '@space/server/api';
import {createAuthentication} from '@space/server/auth';
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
async function terminate(child:ChildProcess){if(child.exitCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
test('two browsers exchange real audio/video, preserve calls across navigation, and release capture',{timeout:180000},async t=>{
 const url=process.env.TEST_DATABASE_URL;if(!url)throw Error('TEST_DATABASE_URL required');
 const schema=`call_browser_${randomBytes(6).toString('hex')}`,admin=new Pool({connectionString:url});
 const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new Pool({connectionString:scoped.toString()}),natsUrl=process.env.NATS_URL??'nats://127.0.0.1:54222';
 const bridge=new EventBridge({databaseUrl:scoped.toString(),natsUrl,schema});
 const port=await freePort(),web=`http://127.0.0.1:${port}`;
 const auth=createAuthentication(pool,{secret:randomBytes(32).toString('hex'),baseURL:web});
 const app=createApi(new PostgresStore(pool),{auth,realtime:{eventUrl:natsUrl}});
 let vite:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 t.after(async()=>{if(browser)for(const context of browser.contexts())for(const page of context.pages()){t.diagnostic(await page.locator('.call-panel').innerText().catch(()=>''));t.diagnostic(JSON.stringify(await page.evaluate(()=>(window as any).callErrors).catch(()=>[])));}await browser?.close();if(vite)await terminate(vite);await app.close();await bridge.close();await pool.end();await admin.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1',[bridge.slot]);await admin.query(`DROP PUBLICATION IF EXISTS "${bridge.publication}"`);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await bridge.start();const seed=await bootstrap(pool),chat=new ChatStore(pool);
 const address=await app.listen({host:'127.0.0.1',port:0});
 vite=spawn('pnpm',['exec','vite','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:fileURLToPath(new URL('../../apps/web',import.meta.url)),env:{...process.env,SPACE_API_URL:address},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Vite startup timeout: '+output)),20000);vite!.stdout!.on('data',chunk=>{output+=chunk;if(output.includes('Local:')){clearTimeout(timer);resolve();}});vite!.stderr!.on('data',chunk=>{output+=chunk;});});
 browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
 const people:{actor:string;page:Page;context:BrowserContext}[]=[];const errors:string[]=[];
 for(const name of ['Alice Caller','Bob Receiver']){
  const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['camera','microphone']});
  await context.addInitScript(()=>{
   const state=window as any;state.callPeers=[];state.captureTracks=[];state.callErrors=[];
   new MutationObserver(()=>{const e=document.querySelector('.call-error');if(e&&!state.callErrors.includes(e.textContent))state.callErrors.push(e.textContent);}).observe(document,{childList:true,subtree:true,characterData:true});
   const Original=window.RTCPeerConnection;
   window.RTCPeerConnection=class extends Original{constructor(config?:RTCConfiguration){super(config);state.callPeers.push(this);}};
   const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await get(constraints);state.captureTracks.push(...stream.getTracks());return stream;};
  });
  const signup=await context.request.post(`${web}/v1/auth/sign-up/email`,{data:{name,email:`${name.split(' ')[0]}-${schema}@example.test`,password:randomBytes(18).toString('hex')},headers:{origin:web}});
  assert.equal(signup.status(),200,await signup.text());const actor=(await signup.json()).user.id;
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[seed.workspace_id,actor]);
  await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)',[seed.workspace_id,seed.channel_id,actor]);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));people.push({actor,page,context});
 }
 const [a,b]=people as [typeof people[number],typeof people[number]];
 const dm=await chat.directMessages.open(a.actor,seed.workspace_id,{user_id:b.actor});await chat.directMessages.open(b.actor,seed.workspace_id,{user_id:a.actor});
 for(const person of [a,b])await person.page.goto(`${web}/chat?workspace=${seed.workspace_id}&channel=${dm.id}`);
 const panel=(p:Page)=>p.getByRole('region',{name:'Call',exact:true});
 t.after(async()=>{if(browser)for(const [index,person] of people.entries()){if(!person.page.isClosed())await person.page.screenshot({path:fileURLToPath(new URL(`../test-results/calling-${index}.png`,import.meta.url)),fullPage:true}).catch(()=>{});}});
 await mkdir(fileURLToPath(new URL('../test-results/',import.meta.url)),{recursive:true});
 await expect(a.page.getByRole('button',{name:'Start video call',exact:true})).toBeEnabled({timeout:20000});
 await a.page.getByRole('button',{name:'Start video call',exact:true}).click();
 await expect(panel(a.page).getByText('Your camera is only visible to you')).toBeVisible();
 assert.equal((await pool.query('SELECT count(*)::int n FROM dm_calls')).rows[0].n,0);
 await panel(a.page).getByRole('button',{name:'Start video call',exact:true}).click();
 await expect(panel(b.page).getByText('Incoming video call')).toBeVisible({timeout:15000});
 assert.equal(await b.page.evaluate(()=>(window as any).captureTracks.length),0,'ringing must never capture recipient media');
 await panel(b.page).getByRole('button',{name:'Preview camera',exact:true}).click();
 await expect(panel(b.page).getByText('Your camera is only visible to you')).toBeVisible();
 await panel(b.page).getByRole('button',{name:'Answer with video',exact:true}).click();
 for(const person of [a,b]){
  await expect(panel(person.page).getByRole('status')).toHaveText('Connected',{timeout:30000});
  await person.page.waitForFunction(async()=>{const pc=(window as any).callPeers.at(-1) as RTCPeerConnection;if(!pc)return false;const stats=await pc.getStats();return [...stats.values()].some(s=>s.type==='inbound-rtp'&&s.kind==='video'&&s.bytesReceived>0&&s.framesDecoded>0)&&[...stats.values()].some(s=>s.type==='inbound-rtp'&&s.kind==='audio'&&s.bytesReceived>0);});
 }
 if(process.env.CALL_ICE_RELAY_ONLY==='true')for(const person of [a,b])assert.equal(await person.page.evaluate(async()=>{
  const stats=await ((window as any).callPeers.at(-1) as RTCPeerConnection).getStats();
  const transport=[...stats.values()].find(s=>s.type==='transport'&&s.selectedCandidatePairId);
  const pair=transport&&stats.get(transport.selectedCandidatePairId);
  return pair&&stats.get(pair.localCandidateId)?.candidateType;
 }),'relay','relay-only test must use an actual TURN allocation');
 await a.page.screenshot({path:fileURLToPath(new URL('../test-results/calling-video.png',import.meta.url)),fullPage:true});
 await panel(a.page).getByRole('button',{name:'Mute microphone',exact:true}).click();
 assert.equal(await a.page.evaluate(()=>(window as any).captureTracks.filter((t:MediaStreamTrack)=>t.kind==='audio'&&t.readyState==='live').every((t:MediaStreamTrack)=>!t.enabled)),true);
 await panel(a.page).getByRole('button',{name:'Turn camera off',exact:true}).click();
 await expect(panel(a.page).getByRole('button',{name:'Turn camera on',exact:true})).toBeEnabled();
 await panel(a.page).getByRole('button',{name:'Turn camera on',exact:true}).click();
 await expect(panel(a.page).getByRole('button',{name:'Turn camera off',exact:true})).toBeEnabled();
 await panel(a.page).getByRole('button',{name:'Minimize call',exact:true}).click();
 assert.equal(await panel(a.page).locator('video').count(),2,'minimizing must retain media playback elements');
 assert.equal(await panel(a.page).locator('video').first().evaluate((v:HTMLVideoElement)=>v.paused),false);
 await panel(a.page).getByRole('button',{name:'Expand call',exact:true}).click();
 await b.context.setOffline(true);
 await expect(panel(b.page).getByRole('status')).toHaveText('Reconnecting…',{timeout:15000});
 await b.context.setOffline(false);
 await expect(panel(b.page).getByRole('status')).toHaveText('Connected',{timeout:20000});
 await a.page.getByRole('link',{name:'Home',exact:true}).click();
 await expect(panel(a.page).getByRole('status')).toHaveText('Connected');
 await panel(a.page).getByRole('button',{name:'Hang up',exact:true}).click();
 for(const person of [a,b]){
  await expect(panel(person.page).getByRole('status')).toHaveText('Call ended',{timeout:15000});
  assert.equal(await person.page.evaluate(()=>(window as any).captureTracks.every((t:MediaStreamTrack)=>t.readyState==='ended')),true);
 }
 await panel(b.page).getByRole('button',{name:'Dismiss call',exact:true}).click();
 await b.page.getByRole('button',{name:'Start voice call',exact:true}).click();
 await expect(panel(a.page).getByText('Incoming voice call')).toBeVisible({timeout:15000});
 await panel(a.page).getByRole('button',{name:'Answer with audio',exact:true}).click();
 for(const person of [a,b])await expect(panel(person.page).getByRole('status')).toHaveText('Connected',{timeout:30000});
 for(const person of [a,b]){
  assert.equal(await person.page.evaluate(()=>(window as any).captureTracks.filter((t:MediaStreamTrack)=>t.kind==='video'&&t.readyState==='live').length),0);
  await panel(person.page).getByRole('button',{name:'Turn camera on',exact:true}).click();
 }
 for(const person of [a,b])await person.page.waitForFunction(async()=>{const pc=(window as any).callPeers.at(-1) as RTCPeerConnection;return [...(await pc.getStats()).values()].some(s=>s.type==='inbound-rtp'&&s.kind==='video'&&s.bytesReceived>0&&s.framesDecoded>0);});
 await panel(b.page).getByRole('button',{name:'Hang up',exact:true}).click();
 for(const person of [a,b]){await expect(panel(person.page).getByRole('status')).toHaveText('Call ended');assert.equal(await person.page.evaluate(()=>(window as any).captureTracks.every((t:MediaStreamTrack)=>t.readyState==='ended')),true);}
 assert.deepEqual(errors,[]);
});
