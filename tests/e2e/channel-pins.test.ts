import {test, type TestContext} from 'node:test';
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

async function openWorkspace(t: TestContext) {
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
    await expect(page.getByText('Shared release notes',{exact:true})).toBeVisible({ timeout: 15_000 });
    return page;
  }
  const alice=await openMember('alice'), bob=await openMember('bob');
  return { alice, bob, pool, seed, web, chat, root };
}

test('private channel, thread and DM drafts follow their author between independent browsers', {timeout:150_000}, async t => {
  const {alice, bob, seed, web} = await openWorkspace(t);
  const context = await alice.context().browser()!.newContext({viewport:{width:1280,height:800}});
  t.after(() => context.close());
  await context.addCookies(await alice.context().cookies());
  const second = await context.newPage();
  const channelUrl = alice.url();
  await second.goto(channelUrl);
  const main = (page: typeof alice) => page.locator('#chat-messages .ql-editor[contenteditable=true]');
  const thread = (page: typeof alice) => page.getByRole('region', {name:'Thread',exact:true}).locator('.ql-editor[contenteditable=true]');
  await expect(main(second)).toBeVisible();
  const channelDraft = 'Channel notes ' + randomUUID();
  await main(alice).fill(channelDraft);
  await expect(main(second)).toHaveText(channelDraft, {timeout:15000});
  await expect(main(bob)).toHaveText('');
  await second.reload();
  await expect(main(second)).toHaveText(channelDraft, {timeout:15000});
  for (const page of [alice, second]) {
    const message = page.getByRole('article').filter({hasText:'Shared release notes'});
    await message.hover();
    await message.getByRole('button', {name:/^Reply to /}).click();
    await expect(page.getByRole('region', {name:'Thread',exact:true}).getByRole('article').filter({hasText:'Shared release notes'})).toBeVisible();
    await expect(thread(page)).toBeVisible();
  }
  const replyDraft = 'Reply notes ' + randomUUID();
  const written = second.waitForResponse(response =>
    response.request().method() === 'PUT' && decodeURIComponent(response.url()).includes('/composer-drafts/thread:'),
    {timeout:15000});
  await thread(second).click();
  await thread(second).pressSequentially(replyDraft);
  await expect(thread(second)).toHaveText(replyDraft);
  const saved = await written;
  assert.equal(saved.status(), 200, await saved.text());
  await expect(thread(alice)).toHaveText(replyDraft, {timeout:15000});
  await expect(main(alice)).toHaveText(channelDraft);
  await alice.getByRole('button', {name:'Drafts & sent',exact:true}).click();
  await expect(alice.getByRole('heading', {name:'Drafts & sent'})).toBeVisible();
  const draftList = alice.getByRole('main').filter({has:alice.getByText(replyDraft,{exact:true})});
  await expect(draftList.getByRole('button').filter({hasText:channelDraft})).toBeVisible();
  await draftList.getByRole('button').filter({hasText:replyDraft}).click();
  await expect(thread(alice)).toHaveText(replyDraft);
  await expect(main(alice)).toHaveText(channelDraft);
  await thread(alice).press('Enter');
  await expect(thread(second)).toHaveText('', {timeout:15000});
  await expect(second.getByRole('region', {name:'Thread',exact:true}).getByRole('article').filter({hasText:replyDraft})).toBeVisible();
  await second.getByRole('button', {name:'Close thread',exact:true}).click();
  await main(second).click();
  await main(second).press('ControlOrMeta+a');
  await main(second).press('Backspace');
  await expect(main(second)).toHaveText('');
  await expect(main(alice)).toHaveText('', {timeout:15000});
  const peer = await (await bob.request.get(web + '/v1/me')).json();
  const dm = await alice.request.post(web + '/v1/workspaces/' + seed.workspace_id + '/direct-messages', {
    data:{user_id:peer.id},headers:{origin:web},
  });
  assert.ok(dm.ok());
  const dmUrl = web + '/chat?workspace=' + seed.workspace_id + '&channel=' + (await dm.json()).id;
  for (const page of [alice, second, bob]) {
    await page.goto(dmUrl);
    await expect(page.getByRole('button', {name:'More conversation actions'})).toBeVisible();
    await expect(main(page)).toBeEditable();
  }
  const privateDraft = 'Personal DM notes ' + randomUUID();
  await main(second).fill(privateDraft);
  await expect(main(alice)).toHaveText(privateDraft, {timeout:15000});
  await expect(main(bob)).toHaveText('');
  const otherDrafts = await bob.request.get(web + '/v1/composer-drafts');
  assert.ok(otherDrafts.ok());
  assert.deepEqual((await otherDrafts.json()).items, []);
  await alice.reload();
  await expect(main(alice)).toHaveText(privateDraft, {timeout:15000});
});

test('personal sidebar sections move channels and DMs and sync only to the owner', {timeout:150_000}, async t => {
  const { alice, bob, pool, seed, web } = await openWorkspace(t);
  const channel = (await pool.query('SELECT name FROM channels WHERE id=$1', [seed.channel_id])).rows[0].name as string;
  const bobProfile = await bob.request.get(web + '/v1/me');
  assert.ok(bobProfile.ok());
  const peer = await bobProfile.json();
  const response = await alice.request.post(web + '/v1/workspaces/' + seed.workspace_id + '/direct-messages', {
    data: { user_id: peer.id }, headers: { origin: web },
  });
  assert.ok(response.ok());
  const dmName = (await response.json()).name as string;
  const second = await alice.context().newPage();
  try {
    await second.goto(alice.url());
    const list = alice.getByRole('navigation', { name: 'Workspace conversations' });
    const group = (name: string) => list.getByRole('region', { name, exact: true });
    const destination = 'Release planning';
    await group('Channels').hover();
    await group('Channels').getByRole('button', { name: 'Manage Channels' }).click();
    await alice.getByRole('menuitem', { name: 'Create section' }).click();
    const dialog = alice.getByRole('dialog', { name: 'Create section' });
    await dialog.getByRole('button', { name: 'Team', exact: true }).click();
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(group('Team')).toBeVisible();
    await expect(group('Channels').getByRole('button', { name: channel, exact: true })).toBeVisible();

    await alice.getByRole('button', { name: 'Organize conversation' }).click();
    await alice.getByRole('menuitem', { name: 'Create new section' }).click();
    await dialog.getByRole('textbox', { name: 'Section name', exact: true }).fill(destination);
    await dialog.getByRole('button', { name: 'Choose section emoji' }).click();
    const picker = dialog.getByRole('dialog', { name: 'Choose section emoji' });
    await picker.getByRole('searchbox').fill('rocket');
    await picker.getByRole('button', { name: '🚀 :rocket:', exact: true }).click();
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    const custom = group(destination);
    await expect(custom.getByRole('button', { name: channel, exact: true })).toBeVisible();
    const heading = custom.getByRole('button', { name: destination, exact: true });
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await list.getByRole('button', { name: dmName, exact: true }).dragTo(heading);
    const secondHeading = second.getByRole('button', { name: destination, exact: true });
    await expect(secondHeading).toHaveAttribute('aria-expanded', 'false');
    await heading.click();
    const siblingGroup = second.getByRole('region', { name: destination, exact: true });
    await expect(siblingGroup.getByRole('button', { name: dmName, exact: true })).toBeVisible();
    await expect(bob.getByRole('button', { name: destination, exact: true })).toHaveCount(0);
    await alice.reload();
    await expect(alice.getByRole('button', { name: 'Move conversation from ' + destination })).toHaveText('🚀');
    await expect(custom.getByRole('button', { name: channel, exact: true })).toBeVisible();
    await expect(custom.getByRole('button', { name: dmName, exact: true })).toBeVisible();
    await custom.getByRole('button', { name: channel, exact: true }).click({ button: 'right' });
    await alice.getByRole('menuitem', { name: 'Move to section', exact: true }).hover();
    await alice.getByRole('menuitemradio', { name: 'Channels', exact: true }).click();
    await expect(group('Channels').getByRole('button', { name: channel, exact: true })).toBeVisible();
  } finally { await second.close(); }
});

test('two members see channel pins, shares, and tab visibility without refreshing', {timeout:150_000}, async t=>{
  const { alice, bob, pool, seed, web, chat, root } = await openWorkspace(t);
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
