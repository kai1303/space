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
import {EventBridge} from '@space/event-service/bridge';
import {createApi} from '@space/server/api';
import {createAuthentication} from '@space/server/auth';

async function freePort():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return port;}
async function terminate(child:ChildProcess){if(child.exitCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}

test('two members see channel pins, shares, and tab visibility without refreshing', {timeout:150_000}, async t=>{
  const databaseUrl=process.env.TEST_DATABASE_URL;if(!databaseUrl)throw new Error('TEST_DATABASE_URL required');
  const schema=`pins_browser_${randomBytes(6).toString('hex')}`;
  const admin=new Pool({connectionString:databaseUrl});
  const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema}`);
  const pool=new Pool({connectionString:scoped.toString()});
  const natsUrl=process.env.NATS_URL??'nats://127.0.0.1:54222';
  const bridge=new EventBridge({databaseUrl:scoped.toString(),natsUrl,schema});
  const webPort=await freePort(),web=`http://127.0.0.1:${webPort}`;
  const auth=createAuthentication(pool,{secret:randomBytes(32).toString('hex'),baseURL:web});
  const app=createApi(new PostgresStore(pool),{auth,realtime:{eventUrl:natsUrl}});
  let vite:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  t.after(async()=>{
    await browser?.close();if(vite)await terminate(vite);await app.close();await bridge.close();await pool.end();
    for (let attempt=0; ;attempt++) {
      try { await admin.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1',[bridge.slot]); break; }
      catch (error) {
        if ((error as {code?:string}).code !== '55006' || attempt >= 6) throw error;
        await new Promise(resolve => setTimeout(resolve,50 * 2 ** attempt));
      }
    }
    await admin.query(`DROP PUBLICATION IF EXISTS "${bridge.publication}"`);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await bridge.start();
  const seed=await bootstrap(pool),chat=new ChatStore(pool);
  const root = await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:'Shared release notes'});
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
    await expect(page.getByText('Shared release notes',{exact:true})).toBeVisible();
    return page;
  }
  const alice=await openMember('alice'), bob=await openMember('bob');
  await t.test('channel context menu handles copy, mute, settings, split view and leave confirmation', async () => {
    const name = (await pool.query('SELECT name FROM channels WHERE id=$1',[seed.channel_id])).rows[0].name;
    const row = alice.getByRole('navigation',{name:'Workspace conversations'}).getByRole('button',{name,exact:true});
    const menu = alice.getByRole('menu',{name:'Actions for '+name});
    const open = () => row.click({button:'right'});
    await open();
    await expect(menu.getByRole('menuitemradio',{name:'Just mentions'})).toBeChecked();
    await menu.getByRole('menuitem',{name:'Copy',exact:true}).hover();
    const copy = menu.getByRole('menu',{name:'Copy',exact:true});
    await expect(copy.getByRole('menuitem')).toHaveText(['Copy name','Copy link','Copy huddle link']);
    await alice.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:web});
    await copy.getByRole('menuitem',{name:'Copy huddle link'}).click();
    const link = new URL(await alice.evaluate(() => navigator.clipboard.readText()));
    assert.equal(link.origin,web);
    assert.equal(link.searchParams.get('huddle'),'1');
    await open();
    await menu.getByRole('menuitemradio',{name:'Mute and hide'}).click();
    await expect(row).toHaveCount(0);
    await alice.reload();
    await alice.getByRole('button',{name:'Show muted channels'}).click();
    await open();
    await expect(menu.getByRole('menuitemradio',{name:'Mute and hide'})).toBeChecked();
    await menu.getByRole('menuitem',{name:'More options'}).click();
    await menu.getByRole('menuitem',{name:'Advanced settings'}).click();
    const editor = alice.getByRole('dialog',{name:'Advanced settings'});
    await expect(editor).toBeVisible();
    await editor.getByRole('switch',{name:'Badge every new message in your sidebar'}).click();
    await expect(editor.getByRole('switch',{name:'Badge every new message in your sidebar'})).toBeChecked();
    await editor.getByRole('button',{name:'Close',exact:true}).click();
    await open();
    await menu.getByRole('menuitemradio',{name:'Just mentions'}).click();
    await open();
    await menu.getByRole('menuitem',{name:'Open in split view'}).click();
    const split = alice.frameLocator('iframe[title="Conversation in #'+name+'"]');
    await expect(split.getByText('Shared release notes',{exact:true})).toBeVisible();
    await expect(split.getByRole('navigation',{name:'Main navigation'})).toHaveCount(0);
    await expect(alice.getByText('Shared release notes',{exact:true})).toBeVisible();
    await alice.getByRole('button',{name:'Close split view'}).click();
    await open();
    await menu.getByRole('menuitem',{name:'Leave channel'}).click();
    await alice.getByRole('dialog',{name:'Leave #'+name+'?'}).getByRole('button',{name:'Cancel'}).click();
    await expect(row).toBeVisible();
  });
  for(const page of [alice,bob]) await expect(page.getByRole('tab',{name:'Pins'})).toHaveCount(0);
  await alice.getByRole('article').filter({hasText:'Shared release notes'}).hover();
  await alice.getByRole('button',{name:'More actions',exact:true}).click();
  await alice.getByRole('menuitem',{name:'Pin to channel'}).click();
  for(const page of [alice,bob]) {
    await page.getByRole('tab',{name:'Pins'}).click({timeout:12000});
    await expect(page.getByRole('region',{name:'Pinned messages'}).getByText('Shared release notes')).toBeVisible();
  }
  await bob.reload();
  await bob.getByRole('tab',{name:'Pins'}).click();
  await bob.getByRole('button',{name:'Pinned message actions'}).click();
  await bob.getByRole('menuitem',{name:'Unpin from channel'}).click();
  for(const page of [bob,alice]) {
    await expect(page.getByRole('tab',{name:'Pins'})).toHaveCount(0,{timeout:12000});
    await expect(page.getByRole('tab',{name:'Messages'})).toHaveAttribute('aria-selected','true');
    await expect(page.getByText('Shared release notes',{exact:true})).toBeVisible();
  }
  const resources = (p: typeof alice) => p.getByRole('tab', {name:'Files & links', exact:true});
  for (const p of [alice,bob]) await expect(resources(p)).toHaveCount(0);
  const shared = await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),thread_id:root.thread_id,text:'See https://example.test/notes.'});
  for (const p of [alice,bob]) {
    await resources(p).click({timeout:12000});
    await expect(p.getByRole('link',{name:'https://example.test/notes',exact:true})).toBeVisible();
  }
  async function customizeTabs() {
    await alice.getByRole('button',{name:'Add or manage tabs'}).click();
    await alice.getByRole('menuitem',{name:'Customize tabs'}).click();
    const dialog = alice.getByRole('dialog').filter({has:alice.getByRole('tablist',{name:'Channel details'})});
    await expect(dialog.getByRole('tab',{name:'Tabs',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(dialog.getByRole('heading',{name:'Manage tabs'})).toBeVisible();
    return dialog;
  }
  // Untouched tabs follow the last share just as they do the first share.
  await chat.deleteMessage(seed.owner_id,seed.channel_id,shared.id);
  await expect(resources(bob)).toHaveCount(0,{timeout:12000});
  await expect(bob.getByRole('tab',{name:'Messages'})).toHaveAttribute('aria-selected','true');

  const editor = await customizeTabs();
  await editor.getByRole('button',{name:'Show Files & links tab'}).click();
  await resources(bob).click();
  await expect(bob.getByRole('heading',{name:'No files shared yet'})).toBeVisible();
  await editor.getByRole('button',{name:'Show Pins tab'}).click();
  await bob.getByRole('tab',{name:'Pins'}).click();
  await expect(bob.getByRole('heading',{name:'No pinned messages yet'})).toBeVisible();
  const header = bob.getByRole('tablist',{name:'Channel views'});
  const headerTabs = header.getByRole('tab');
  await expect(editor.getByRole('button',{name:'Move Files & links up'})).toBeDisabled();
  await editor.getByRole('button',{name:'Move Pins up'}).click();
  await expect(headerTabs).toHaveText(['Messages','Pins','Files & links']);
  await expect(header.getByRole('tab',{name:'Messages'})).not.toHaveAttribute('draggable','true');
  await header.getByRole('tab',{name:'Pins'}).dragTo(resources(bob));
  await expect(headerTabs).toHaveText(['Messages','Files & links','Pins']);
  await expect(editor.getByRole('button',{name:'Move Files & links up'})).toBeDisabled();
  await expect(header.getByRole('tab',{name:'Pins'})).toHaveAttribute('aria-selected','true');
  await editor.getByRole('button',{name:'Move Files & links down'}).click();
  await expect(headerTabs).toHaveText(['Messages','Pins','Files & links']);
  await bob.reload();
  await expect(headerTabs).toHaveText(['Messages','Pins','Files & links']);
  await header.getByRole('tab',{name:'Pins'}).click();
  await chat.setChannelPin(seed.owner_id,seed.channel_id,root.id,true);
  const pinned = bob.getByRole('region',{name:'Pinned messages'});
  await expect(pinned.getByText(root.text)).toBeVisible();
  await pinned.getByRole('button',{name:'Pinned message actions'}).click();
  await bob.getByRole('menuitem',{name:'Unpin from channel'}).click();
  await expect(pinned.getByRole('heading',{name:'No pinned messages yet'})).toBeVisible();
  await editor.getByRole('button',{name:'Hide Pins tab'}).click();
  await expect(bob.getByRole('tab',{name:'Pins'})).toHaveCount(0);
  await expect(bob.getByRole('tab',{name:'Messages'})).toHaveAttribute('aria-selected','true');
  await alice.reload();
  const restored = await customizeTabs();
  await expect(restored.getByRole('button',{name:'Hide Files & links tab'})).toBeEnabled();
  await expect(restored.getByRole('button',{name:'Show Pins tab'})).toBeEnabled();
  await chat.setChannelPin(seed.owner_id,seed.channel_id,root.id,true);
  await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),text:'Settings sync check'});
  await expect(bob.getByText('Settings sync check',{exact:true})).toBeVisible();
  await expect(bob.getByRole('tab',{name:'Pins'})).toHaveCount(0);
});
