import {conversationPath} from '@space/contracts';
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
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
import {huddleMedia} from '@space/server/huddle-media';
import {createAuthentication} from '@space/server/auth';

async function freePort():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return port;}
async function terminate(child:ChildProcess){if(child.exitCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}

async function openWorkspace(t: TestContext, media?:ReturnType<typeof huddleMedia>) {
  const databaseUrl=process.env.TEST_DATABASE_URL;if(!databaseUrl)throw new Error('TEST_DATABASE_URL required');
  const schema=`pins_browser_${randomBytes(6).toString('hex')}`;
  const admin=new Pool({connectionString:databaseUrl});
  const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema}`);
  const pool=new Pool({connectionString:scoped.toString()});
  const natsUrl=process.env.NATS_URL??'nats://127.0.0.1:54222';
  const bridge=new EventBridge({databaseUrl:scoped.toString(),natsUrl,schema});
  const webPort=await freePort(),web=`http://127.0.0.1:${webPort}`;
  const auth=createAuthentication(pool,{secret:randomBytes(32).toString('hex'),baseURL:web});
  const app=createApi(new PostgresStore(pool),{auth,huddles:media,realtime:{eventUrl:natsUrl}});
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
  const draftsUrl = alice.url();
  const draftList = alice.getByRole('main').filter({has:alice.getByText(replyDraft,{exact:true})});
  await expect(draftList.getByRole('button').filter({hasText:channelDraft})).toBeVisible();
  const replyRow = draftList.getByRole('listitem').filter({hasText:replyDraft});
  await replyRow.hover();
  await replyRow.getByRole('button',{name:'Edit draft'}).click();
  await expect(thread(alice)).toBeFocused();
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
  await alice.goto(draftsUrl);
  const dmRow = alice.getByRole('listitem').filter({hasText:privateDraft});
  await dmRow.hover();
  await dmRow.getByRole('button',{name:'Edit draft'}).click();
  await expect(main(alice)).toBeFocused();
  await expect(main(alice)).toHaveText(privateDraft);
  const otherDrafts = await bob.request.get(web + '/v1/composer-drafts');
  assert.ok(otherDrafts.ok());
  assert.deepEqual((await otherDrafts.json()).items, []);
  await alice.reload();
  await expect(main(alice)).toHaveText(privateDraft, {timeout:15000});
});

test('draft row and Edit reopen the same channel composer and retain unsent edits', {timeout:90_000}, async t => {
  const {alice,bob} = await openWorkspace(t);
  const text = 'Notes to revise', updated = 'Notes together to revise';
  const editor = alice.locator('#chat-messages .ql-editor[contenteditable=true]');
  const drafts = alice.getByRole('button',{name:'Drafts & sent',exact:true});
  await editor.fill(text);
  await editor.press('Home');
  for (let i = 0; i < 'Notes'.length; i++) await editor.press('ArrowRight');
  await drafts.click();
  const row = alice.getByRole('listitem').filter({hasText:'Notes'});
  await row.hover();
  const edit = row.getByRole('button',{name:'Edit draft'});
  await edit.focus();
  if (process.env.SPACE_DRAFT_SCREENSHOTS) await alice.screenshot({path:process.env.SPACE_DRAFT_SCREENSHOTS+'/edit-row.png'});
  await edit.press('Enter');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText(text);
  await alice.keyboard.type(' together');
  await drafts.click();
  await expect(row).toContainText(updated);
  await expect(bob.getByRole('article').filter({hasText:updated})).toHaveCount(0);
  await row.getByRole('button').filter({hasText:updated}).click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText(updated);
  const sendButton = alice.locator('#chat-messages').getByRole('button',{name:'Send now',exact:true});
  await expect(sendButton).toBeEnabled();
  if (process.env.SPACE_DRAFT_SCREENSHOTS) await alice.screenshot({path:process.env.SPACE_DRAFT_SCREENSHOTS+'/edit-conversation.png'});
  await editor.press('Enter');
  await expect(bob.getByRole('article').filter({hasText:updated})).toHaveCount(1);
  await drafts.click();
  await expect(row).toHaveCount(0);
  await alice.getByRole('main').getByRole('button',{name:'New message'}).click();
  const compose = alice.locator('.dm-new-message .ql-editor');
  await compose.fill('Choose recipient later');
  await alice.getByRole('link',{name:'Home',exact:true}).click();
  await drafts.click();
  const detached = alice.getByRole('listitem').filter({hasText:'Choose recipient later'});
  await detached.hover();
  await detached.getByRole('button',{name:'Edit draft'}).click();
  await expect(alice.getByRole('searchbox',{name:'To'})).toBeVisible();
  await expect(compose).toHaveText('Choose recipient later');
});

test('draft trash confirms before clearing only the selected draft across devices', {timeout:90_000}, async t => {
  const {alice} = await openWorkspace(t);
  const device = await alice.context().browser()!.newContext();
  t.after(() => device.close());
  await device.addCookies(await alice.context().cookies());
  const second = await device.newPage();
  await second.goto(alice.url());
  const editor = second.locator('#chat-messages .ql-editor[contenteditable=true]');
  await expect(second.getByText('Shared release notes',{exact:true})).toBeVisible();
  await alice.locator('#chat-messages .ql-editor[contenteditable=true]').fill('Private notes to delete');
  await expect(editor).toHaveText('Private notes to delete', {timeout:15000});
  const drafts = alice.getByRole('button',{name:'Drafts & sent',exact:true});
  await drafts.click();
  const row = alice.getByRole('listitem').filter({hasText:'Private notes'});
  const trash = row.getByRole('button',{name:'Delete draft'});
  const dialog = alice.getByRole('dialog',{name:'Delete draft?'});
  const confirm = dialog.getByRole('button',{name:'Delete Draft',exact:true});
  await row.hover();
  await trash.click();
  await expect(dialog).toContainText('Are you sure you want to delete this draft to general?');
  await expect(confirm).toBeFocused();
  if (process.env.SPACE_DRAFT_SCREENSHOTS) await alice.screenshot({path:process.env.SPACE_DRAFT_SCREENSHOTS+'/delete-dialog.png',animations:'disabled'});
  await dialog.getByRole('button',{name:'Cancel'}).click();
  await expect(dialog).toHaveCount(0);
  await expect(trash).toBeFocused();
  await expect(editor).toHaveText('Private notes to delete');
  await trash.press('Enter');
  await editor.fill('Private notes revised on another device');
  await expect(dialog.getByText('This draft changed. Review it before deleting.',{exact:true})).toBeVisible();
  await expect(confirm).toBeDisabled();
  await alice.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await trash.click();
  await expect(confirm).toBeFocused();
  await alice.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(editor).toHaveText('', {timeout:15000});
  await alice.reload();
  await expect(alice.getByRole('heading',{name:'Draft messages to send when you’re ready'})).toBeVisible();
  await alice.getByRole('main').getByRole('button',{name:'New message'}).click();
  await alice.locator('.dm-new-message .ql-editor').fill('Unaddressed draft');
  await alice.getByRole('link',{name:'Home',exact:true}).click();
  await drafts.click();
  const local = alice.getByRole('listitem').filter({hasText:'Unaddressed draft'});
  await local.hover();
  await local.getByRole('button',{name:'Delete draft'}).click();
  await expect(dialog).toContainText('Are you sure you want to delete this draft?');
  await confirm.click();
  await expect(local).toHaveCount(0);
  await alice.reload();
  await expect(alice.getByRole('heading',{name:'Draft messages to send when you’re ready'})).toBeVisible();
});

test('sending a draft from its row restores it on failure and clears it on delivery', {timeout:90_000}, async t => {
  const {alice, bob} = await openWorkspace(t);
  const text = 'Confirm the release date';
  const editor = alice.locator('#chat-messages .ql-editor[contenteditable=true]');
  const saved = alice.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/composer-drafts/'));
  await editor.fill(text);
  assert.ok((await saved).ok());
  await alice.getByRole('button', {name:'Drafts & sent',exact:true}).click();
  const row = alice.getByRole('listitem').filter({hasText:text});
  const action = row.getByRole('button', {name:'Send message'});
  const dialog = alice.getByRole('dialog', {name:'Send message'});
  await row.hover();
  const captures = process.env.SPACE_DRAFT_SCREENSHOTS;
  if (captures) await alice.screenshot({path:captures+'/draft-row.png',animations:'disabled'});
  await action.click();
  await expect(dialog).toContainText('Are you sure');
  if (captures) await alice.screenshot({path:captures+'/confirm.png',animations:'disabled'});
  await dialog.getByRole('button', {name:'Cancel'}).click();
  await expect(row).toBeVisible();
  let reject!: () => void;
  const pending = new Promise<void>(resolve => {reject = resolve;});
  const path = '**/composer-drafts/*/send';
  await alice.route(path, async route => {
    await pending;
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'temporarily_unavailable'})});
  });
  await action.click();
  await dialog.getByRole('button', {name:'Send',exact:true}).click();
  await expect(row).toHaveCount(0);
  reject();
  await expect(row).toBeVisible();
  await expect(alice.getByText('Couldn’t send message', {exact:true})).toBeVisible();
  await alice.unroute(path);
  await row.hover();
  await action.click();
  await dialog.getByRole('button', {name:'Send',exact:true}).click();
  await expect(bob.getByRole('article').filter({hasText:text})).toHaveCount(1);
  await alice.reload();
  await expect(alice.getByRole('heading',{name:'Draft messages to send when you’re ready'})).toBeVisible();
});

test('draft row opens the scheduling dialog and preserves the draft on cancel or failure', {timeout:90_000}, async t => {
  const {alice} = await openWorkspace(t);
  const text = 'Notes for the next design review';
  const saved = alice.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/composer-drafts/'));
  await alice.locator('#chat-messages .ql-editor[contenteditable=true]').fill(text);
  assert.ok((await saved).ok());
  await alice.getByRole('button', {name:'Drafts & sent',exact:true}).click();
  const row = alice.getByRole('listitem').filter({hasText:text});
  const action = row.getByRole('button',{name:'Schedule message'});
  const dialog = alice.getByRole('dialog',{name:'Schedule message'});
  await row.hover();
  if (process.env.SPACE_DRAFT_SCREENSHOTS) await alice.screenshot({path:process.env.SPACE_DRAFT_SCREENSHOTS+'/schedule-row.png'});
  await action.click();
  await expect(dialog).toContainText('Time zone');
  await expect(dialog.getByLabel('Time',{exact:true})).toHaveValue(/:00$/);
  const choose = dialog.getByRole('button',{name:'Schedule Message'});
  await dialog.getByLabel('Date',{exact:true}).fill('2020-01-01');
  await expect(choose).toBeDisabled();
  await dialog.getByRole('button',{name:'Cancel'}).click();
  await expect(row).toBeVisible();
  await action.click();
  await expect(choose).toBeEnabled();
  if (process.env.SPACE_DRAFT_SCREENSHOTS) {
    await expect(dialog).toHaveCSS('opacity','1');
    await alice.screenshot({path:process.env.SPACE_DRAFT_SCREENSHOTS+'/schedule-dialog.png'});
  }
  const path = '**/composer-drafts/*/schedule';
  await alice.route(path,route => route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporarily_unavailable"}'}),{times:1});
  await choose.click();
  await expect(alice.getByText('Couldn’t schedule message',{exact:true})).toBeVisible();
  await expect(row).toBeVisible();
  await action.click();
  await choose.click();
  await expect(row).toHaveCount(0);
  await expect(alice.getByRole('status').filter({hasText:/Scheduled for /})).toHaveText(/See it in Scheduled/);
  await alice.getByRole('tab',{name:'Scheduled',exact:true}).click();
  await expect(alice.getByRole('listitem').filter({hasText:text})).toHaveCount(1);
  await alice.getByRole('tab',{name:'Drafts',exact:true}).click();
  await alice.reload();
  await expect(alice.getByRole('heading',{name:'Draft messages to send when you’re ready'})).toBeVisible();
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

test('channel copy actions confirm the clipboard write', {timeout:120_000}, async t=>{
  const {alice, pool, seed, web}=await openWorkspace(t);
  const {name}=(await pool.query('SELECT name FROM channels WHERE id=$1',[seed.channel_id])).rows[0];
  const row=alice.getByRole('navigation',{name:'Workspace conversations'}).getByRole('button',{name,exact:true});
  await alice.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:web});
  const channelUrl=new URL(conversationPath(seed.channel_id)!,web);
  const huddleUrl=new URL(channelUrl); huddleUrl.searchParams.set('huddle','1');
  for (const [action,confirmation,value] of [
    ['Copy name','Channel name copied',name],
    ['Copy link','Channel link copied',channelUrl.href],
    ['Copy huddle link','Huddle link copied',huddleUrl.href],
  ] as const) {
    await row.click({button:'right'});
    const menu=alice.getByRole('menu',{name:'Actions for '+name});
    await menu.getByRole('menuitem',{name:'Copy',exact:true}).hover();
    await menu.getByRole('menuitem',{name:action,exact:true}).click();
    await expect(alice.getByText(confirmation,{exact:true}).last()).toBeVisible();
    assert.equal(await alice.evaluate(()=>navigator.clipboard.readText()),value);
  }
});

test('undo restores the last channel pin after the Pins tab disappears', {timeout:120_000}, async t=>{
  const {alice,seed,root,chat}=await openWorkspace(t);
  await chat.setChannelPin(seed.owner_id,seed.channel_id,root.id,true);
  const pins=alice.getByRole('tab',{name:'Pins'});
  await pins.click();
  await alice.getByRole('button',{name:'Pinned message actions'}).click();
  await alice.getByRole('menuitem',{name:'Unpin from channel'}).click();
  await expect(pins).toHaveCount(0);
  await alice.getByRole('button',{name:'Undo',exact:true}).click();
  await pins.click();
  await expect(alice.getByRole('region',{name:'Pinned messages'}).getByText('Shared release notes')).toBeVisible();
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

test('thread inbox, timeline reply bars, detached replies and mobile back work across browsers', {timeout:150_000}, async t => {
  const {alice,bob,chat,pool,seed,web} = await openWorkspace(t);
  const actor = async (page: typeof alice) => (await (await page.request.get(web+'/v1/auth/get-session')).json()).user.id as string;
  const aliceId=await actor(alice), bobId=await actor(bob);
  await pool.query('UPDATE users SET display_name=$2 WHERE id=$1',[seed.owner_id,'Maya Chen']);
  await pool.query('UPDATE users SET display_name=$2 WHERE id=$1',[bobId,'Sam Rivera']);
  const post = (author:string,text:string,thread_id?:string) => chat.send(author,seed.channel_id,{client_message_id:randomUUID(),text,thread_id});
  const research=await post(seed.owner_id,'What should we include in the onboarding research readout?');
  await chat.notifications.subscription(aliceId,research.thread_id,{following:true});
  await post(bobId,'The three interviews with first-time admins are ready.',research.thread_id);
  const review=await post(seed.owner_id,'Can we review the release checklist before Thursday’s launch?');
  await chat.notifications.subscription(aliceId,review.thread_id,{following:true});
  await post(bobId,'The desktop smoke tests passed. I added the results to the checklist.',review.thread_id);
  await post(seed.owner_id,'Thanks, Sam. I’ll take the mobile pass this afternoon.',review.thread_id);

  const artifacts=process.env.SPACE_THREAD_SCREENSHOTS;
  const capture=async (page:typeof alice,name:string) => {
    if (!artifacts) return;
    await expect.poll(() => page.getByRole('article').evaluateAll(articles =>
      articles.every(article => Number(getComputedStyle(article).opacity) >= 0.99))).toBe(true);
    await page.screenshot({path:artifacts+'/'+name+'.png',animations:'disabled'});
  };
  await alice.setViewportSize({width:1440,height:900});
  const channelRoot=bob.locator('#chat-message-'+review.id);
  const bar=channelRoot.getByRole('button',{name:'2 replies View thread'});
  await expect(bar).toBeVisible({timeout:15000});
  await expect(bar.locator('.sp-thread-link-face')).toHaveCount(2);
  await expect(bar.locator('time')).toContainText('Last reply');
  await capture(bob,'channel-reply-bar');

  await alice.getByRole('button',{name:'Threads',exact:true}).click();
  const inbox=alice.getByRole('region',{name:'Threads',exact:true});
  const card=inbox.getByRole('article').filter({hasText:review.text});
  const composer=card.locator('.ql-editor[contenteditable=true]');
  await expect(composer).toBeVisible({timeout:15000});
  await expect(inbox.locator('.ql-editor[contenteditable=true]')).toHaveCount(2);
  await capture(alice,'threads-inbox');
  const otherComposer=inbox.getByRole('article').filter({hasText:research.text}).getByRole('textbox',{name:'Reply to thread in general'});
  await otherComposer.fill('Draft for the research thread');
  await bar.click();
  const bobThread=bob.getByRole('region',{name:'Thread',exact:true});
  await composer.fill('Checking the launch notes');
  await expect(bobThread.locator('.chat-typing')).toContainText('alice',{timeout:10000});
  await expect(otherComposer).toHaveText('Draft for the research thread');
  await composer.fill('I’ve checked the release notes. The checklist is ready.');
  await composer.press('Enter');
  await expect(channelRoot.getByRole('button',{name:'3 replies View thread'})).toBeVisible({timeout:15000});
  await expect(card.getByText('I’ve checked the release notes. The checklist is ready.',{exact:true})).toBeVisible();
  await expect(alice.getByRole('region',{name:'Thread',exact:true})).toHaveCount(0);
  await card.getByRole('button',{name:'Show 1 more reply'}).click();
  await expect(card.getByText('The desktop smoke tests passed. I added the results to the checklist.')).toBeVisible();
  const opened=alice.context().waitForEvent('page');
  await card.getByRole('link',{name:'Open thread in a new window'}).click();
  const popup=await opened;
  const popped=popup.getByRole('region',{name:'Thread',exact:true});
  await expect(popped.getByText(review.text,{exact:true})).toBeVisible({timeout:15000});
  await popped.locator('.ql-editor[contenteditable=true]').fill('I’ll post the launch update tomorrow.');
  await popped.locator('.ql-editor[contenteditable=true]').press('Enter');
  await expect(card.getByText('I’ll post the launch update tomorrow.',{exact:true})).toBeVisible({timeout:15000});
  await capture(popup,'thread-window');
  await popup.close();

  await alice.setViewportSize({width:390,height:844});
  await card.getByRole('button',{name:'Open thread in general'}).click();
  const detail=alice.getByRole('region',{name:'Thread',exact:true});
  await expect(detail.getByRole('button',{name:'Back to Threads'})).toBeVisible();
  await expect(inbox).toBeHidden();
  await expect(detail.getByText(review.text,{exact:true})).toBeVisible();
  await expect(detail.locator('.ql-editor[contenteditable=true]')).toBeVisible();
  await capture(alice,'threads-mobile-detail');
  await detail.getByRole('button',{name:'Back to Threads'}).click();
  await expect(card.getByRole('button',{name:'Open thread in general'})).toBeVisible();
  await expect(detail).toHaveCount(0);
  await capture(alice,'threads-mobile-inbox');
  await alice.setViewportSize({width:1440,height:900});
  const latest=card.locator('.thread-preview').filter({hasText:'I’ll post the launch update tomorrow.'});
  await latest.hover();
  await latest.getByRole('button',{name:'More message actions'}).click();
  await alice.getByRole('menuitem',{name:'Turn off notifications for this thread'}).click();
  await expect(card).toHaveCount(0,{timeout:15000});
  await expect(otherComposer).toHaveText('Draft for the research thread');
});

test('a one-to-one DM thread opens from Threads and shares one reply back to the DM', {timeout:100_000}, async t => {
  const {alice,bob,chat,web,seed}=await openWorkspace(t);
  const user=async (page:typeof alice)=>(await (await page.request.get(web+'/v1/me')).json()).id as string;
  const aliceId=await user(alice), bobId=await user(bob);
  const dm=await chat.directMessages.open(aliceId,seed.workspace_id,{user_id:bobId});
  const root=await chat.send(bobId,dm.id,{client_message_id:randomUUID(),text:'Can we move our review to Friday?'});
  await chat.send(bobId,dm.id,{client_message_id:randomUUID(),thread_id:root.thread_id,text:'The morning is open.'});
  await alice.getByRole('button',{name:'Threads',exact:true}).click();
  const card=alice.getByRole('article').filter({hasText:root.text});
  await expect(card.getByText('New replies')).toBeAttached({timeout:15000});
  const panel=card;
  await panel.getByRole('checkbox',{name:'Also send to this conversation'}).check();
  const editor=panel.locator('.ql-editor[contenteditable=true]');
  await editor.fill('Friday works. I’ll send the invite.');
  await editor.press('Enter');
  await expect(panel.getByText('Friday works. I’ll send the invite.',{exact:true})).toBeVisible();
  await expect(card.getByText('New replies')).toHaveCount(0,{timeout:15000});
  await bob.goto(web+'/chat?workspace='+seed.workspace_id+'&channel='+dm.id);
  const timeline=bob.locator('#chat-messages');
  await expect(timeline.getByText('Friday works. I’ll send the invite.',{exact:true})).toBeVisible({timeout:15000});
  await expect(timeline.getByText('The morning is open.',{exact:true})).toHaveCount(0);
  await timeline.getByRole('button',{name:'Replied to a thread'}).click();
  await expect(bob.getByRole('region',{name:'Thread',exact:true}).getByText('The morning is open.',{exact:true})).toBeVisible();
});

test('Huddles picker invites a teammate and keeps the shared thread open during the call', {skip:!process.env.LIVEKIT_URL,timeout:120_000},async t=>{
 const {alice,bob,pool,seed,web}=await openWorkspace(t,huddleMedia());
 const screenshots=process.env.SPACE_HUDDLE_SCREENSHOTS;
 await bob.emulateMedia({reducedMotion:'reduce'});
 await bob.reload();
 await alice.getByRole('button',{name:'Huddles',exact:true}).click();
 const directory=alice.getByRole('main',{name:'Huddles'});
 await expect(directory.getByRole('button',{name:/#.*Start Huddle/})).toBeVisible();
 if(screenshots)await alice.screenshot({path:screenshots+'/directory.png',animations:'disabled'});
 const suggestion=directory.getByRole('button',{name:/#.*Start Huddle/});
 const action=suggestion.getByText('Start Huddle');
 await expect(action).toHaveCSS('opacity','0');
 await suggestion.hover();
 await expect(action).toHaveCSS('opacity','1');
 await directory.getByRole('heading',{name:'Huddles',exact:true}).hover();
 await expect(action).toHaveCSS('opacity','0');
 await directory.getByRole('button',{name:'Dismiss huddles introduction'}).click();
 await expect(directory.getByRole('heading',{name:'Instantly connect over audio or video'})).toHaveCount(0);
 await directory.getByRole('button',{name:'New Huddle'}).click();
 const picker=alice.getByRole('dialog',{name:'Invite someone to your huddle'});
 await picker.getByRole('searchbox').fill('bob');
 await picker.getByRole('button',{name:/bob/i}).click();
 if(screenshots)await alice.screenshot({path:screenshots+'/picker.png',animations:'disabled'});
 await picker.getByRole('button',{name:'Start a Huddle'}).click();
 const prejoin=alice.getByRole('dialog',{name:'Join huddle with bob'});
 await prejoin.getByRole('checkbox').uncheck();
 await prejoin.getByRole('button',{name:'Join huddle'}).click();
 const live=alice.getByRole('region',{name:'Channel huddle'});
 await expect(live).toBeVisible({timeout:25000});
 const invitation=bob.getByRole('complementary',{name:'Huddle invitation'});
 await expect(invitation).toBeVisible({timeout:15000});
 assert.equal(await invitation.evaluate(node=>node.getAnimations().some(animation=>Number(animation.effect?.getComputedTiming().duration)>0)),false);
 await invitation.getByRole('button',{name:'Join'}).click({timeout:15000});
 const invited=bob.getByRole('dialog',{name:'Join huddle with alice'});
 await invited.getByRole('checkbox').uncheck();
 await invited.getByRole('button',{name:'Join huddle'}).click();
 await expect(live.getByText('2 in this huddle')).toBeVisible({timeout:25000});
 await live.getByRole('button',{name:'Reactions'}).click();
 await alice.getByRole('menuitem',{name:'Clap'}).click();
 await expect(bob.getByRole('region',{name:'Channel huddle'}).getByText('alice · 👏')).toBeVisible();
 await live.getByRole('button',{name:'Open huddle thread'}).click();
 await expect(alice.getByRole('region',{name:'Thread',exact:true}).getByText('Started a huddle')).toBeVisible();
 await expect(live.getByRole('button',{name:'Expand huddle'})).toBeVisible();
 await expect(live.getByText('2 in this huddle')).toBeVisible();
 const thread=alice.getByRole('region',{name:'Thread',exact:true});
 const editor=thread.locator('[contenteditable=true]');
 await editor.fill('I’ll share the meeting notes here.');
 await editor.press('Enter');
 await expect(thread.getByText('I’ll share the meeting notes here.',{exact:true})).toBeVisible();
 if(screenshots)await alice.screenshot({path:screenshots+'/thread.png',animations:'disabled'});
 await live.getByRole('button',{name:'Leave'}).click();
 await bob.getByRole('button',{name:'Leave',exact:true}).click();
 const room=(await pool.query("SELECT id FROM channel_huddles WHERE workspace_id=$1 AND state='active'",[seed.workspace_id])).rows[0];
 // The shared LiveKit fixture has a fixed webhook destination; send its signed
 // room-finished callback to this test's ephemeral API instead.
 const body=JSON.stringify({event:'room_finished',room:{name:'space-huddle-'+room.id}});
 const jwt=(value:object)=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const claims={iss:process.env.LIVEKIT_API_KEY,exp:Math.floor(Date.now()/1000)+60,sha256:createHash('sha256').update(body).digest('base64')};
 const unsigned=jwt({alg:'HS256',typ:'JWT'})+'.'+jwt(claims);
 const signature=createHmac('sha256',process.env.LIVEKIT_API_SECRET!).update(unsigned).digest('base64url');
 const closed=await alice.request.post(web+'/v1/huddles/webhook',{data:body,headers:{'content-type':'application/webhook+json',authorization:unsigned+'.'+signature}});
 assert.equal(closed.status(),200,await closed.text());
 await alice.getByRole('link',{name:'Home',exact:true}).click();
 await alice.getByRole('button',{name:'Huddles',exact:true}).click();
 await expect(directory.getByRole('heading',{name:'Recent huddles'})).toBeVisible();
 await directory.getByRole('button',{name:'Open thread'}).click();
 await expect(alice.getByRole('region',{name:'Thread',exact:true}).getByText('Started a huddle')).toBeVisible();
 await expect(alice.getByRole('region',{name:'Thread',exact:true}).getByText('I’ll share the meeting notes here.',{exact:true})).toBeVisible();
});

test('a channel huddle shows its sidebar indicator and invites a member from inside the room',{skip:!process.env.LIVEKIT_URL,timeout:100_000},async t=>{
 const {alice,bob}=await openWorkspace(t,huddleMedia());
 await alice.getByRole('button',{name:'Start huddle',exact:true}).click();
 const dialog=alice.getByRole('dialog',{name:'Join huddle in #general'});
 await dialog.getByRole('checkbox').uncheck();
 await dialog.getByRole('button',{name:'Join huddle'}).click();
 const room=alice.getByRole('region',{name:'Channel huddle'});
 await room.getByRole('button',{name:'Invite people'}).click({timeout:25000});
 await expect(bob.getByRole('img',{name:'Huddle in progress'})).toBeVisible({timeout:15000});
 const picker=alice.getByRole('dialog',{name:'Invite someone to your huddle'});
 await picker.getByRole('searchbox').fill('bob');
 await picker.getByRole('button',{name:/bob/i}).click();
 await picker.getByRole('button',{name:'Invite',exact:true}).click();
 const invitation=bob.getByRole('complementary',{name:'Huddle invitation'});
 await expect(invitation.getByText('You’re invited to a huddle in #general')).toBeVisible({timeout:15000});
 await invitation.getByRole('button',{name:'Dismiss'}).click();
 await expect(invitation).toHaveCount(0);
 await room.getByRole('button',{name:'Leave',exact:true}).click();
});

test('Saved bookmarks sync privately, open in split view, undo clear and move to To-dos', {timeout:100_000}, async t=>{
  const {alice,bob,seed,root,web,chat}=await openWorkspace(t);
  const ctx=await alice.context().browser()!.newContext({viewport:{width:1512,height:834}});
  t.after(()=>ctx.close());await ctx.addCookies(await alice.context().cookies());
  const other=await ctx.newPage();await other.goto(alice.url());
  const shortcut=(page:typeof alice)=>page.getByRole('button',{name:'Saved',exact:true});
  await shortcut(other).click();await expect(other.getByText('Nothing saved yet')).toBeVisible();
  await shortcut(bob).click();await expect(bob.getByText('Nothing saved yet')).toBeVisible();
  const message=alice.getByRole('article').filter({hasText:'Shared release notes'});await message.hover();
  await message.getByRole('button',{name:'More actions'}).click();await alice.getByRole('menuitem',{name:'Add to saved'}).click();
  const row=other.getByRole('button',{name:'View message in general'});await expect(row).toBeVisible({timeout:12000});
  await expect(alice.getByRole('link',{name:'View Saved'})).toBeVisible();
  await expect(bob.getByText('Nothing saved yet')).toBeVisible();
  await row.click();const frame=other.frameLocator('iframe[title="Conversation in general"]');
  await expect(frame.getByRole('article').filter({hasText:'Shared release notes'})).toBeVisible({timeout:15000});
  if(process.env.SPACE_SAVED_SCREENSHOTS)await other.screenshot({path:process.env.SPACE_SAVED_SCREENSHOTS+'/split.png',animations:'disabled'});
  await other.getByRole('button',{name:'Close split view'}).click();
  await expect(other.locator('.saved-split')).toHaveCount(0);
  if(process.env.SPACE_SAVED_SCREENSHOTS)await other.screenshot({path:process.env.SPACE_SAVED_SCREENSHOTS+'/saved.png',animations:'disabled'});
  await row.hover();await other.getByRole('button',{name:/Remove saved message from/}).click();
  await expect(other.getByText('Nothing saved yet')).toBeVisible();await expect(alice.getByRole('link',{name:'View Saved'})).toHaveCount(0);
  await other.getByRole('button',{name:'Undo',exact:true}).click();await expect(row).toBeVisible();
  await other.getByRole('button',{name:'Clean up'}).click();
  await other.getByRole('menuitem',{name:'Move saved items to to-dos'}).click();
  await other.getByRole('dialog').getByRole('button',{name:'Move to To-dos'}).click();
  await expect(other.getByText('Nothing saved yet')).toBeVisible();
  const todos=await (await ctx.request.get(web+'/v1/workspaces/'+seed.workspace_id+'/hub/todos')).json();
  assert.deepEqual(todos.items.map((m:{message_id:string})=>m.message_id),[root.id]);
  const me=await (await alice.request.get(web+'/v1/me')).json(),peer=await (await bob.request.get(web+'/v1/me')).json();
  const dmResponse=await alice.request.post(web+'/v1/workspaces/'+seed.workspace_id+'/direct-messages',{data:{user_id:peer.id},headers:{origin:web}});
  assert.ok(dmResponse.ok());
  const dm=(await dmResponse.json()).id;
  await chat.send(me.id,dm,{client_message_id:randomUUID(),text:'A note from our DM'});
  await chat.send(seed.owner_id,seed.channel_id,{client_message_id:randomUUID(),thread_id:root.thread_id,text:'The final checklist is in this thread.\nPlease review the release notes before Friday.'});
  await message.hover();await message.getByRole('button',{name:/^Reply to /}).click();
  const reply=alice.getByRole('region',{name:'Thread',exact:true}).getByRole('article').filter({hasText:'The final checklist is in this thread'});
  await reply.hover();await reply.getByRole('button',{name:'More actions'}).click();
  await alice.getByRole('menuitem',{name:'Add to saved'}).click();
  await expect(row).toContainText('The final checklist is in this thread');
  await alice.goto(web+'/chat?workspace='+seed.workspace_id+'&channel='+dm);
  const dmRow=alice.getByRole('article').filter({hasText:'A note from our DM'});
  await dmRow.hover();await dmRow.getByRole('button',{name:'More actions'}).click();
  await alice.getByRole('menuitem',{name:'Add to saved'}).click();
  await expect(other.getByRole('list',{name:'Saved messages'})).toContainText('A note from our DM');
  await expect(other.getByRole('list',{name:'Saved messages'}).getByRole('listitem')).toHaveCount(2);
  await expect(bob.getByText('Nothing saved yet')).toBeVisible();
  await other.getByRole('button',{name:'Dismiss notification'}).click();
  await other.getByRole('heading',{name:'Saved',exact:true}).click();
  if(process.env.SPACE_SAVED_SCREENSHOTS)await other.screenshot({path:process.env.SPACE_SAVED_SCREENSHOTS+'/saved.png',animations:'disabled'});
  await other.getByRole('button',{name:'View message in bob'}).click();
  const directSplit=other.frameLocator('iframe[title="Conversation in bob"]');
  await expect(directSplit.getByRole('article').filter({hasText:'A note from our DM'})).toBeVisible();
  if(process.env.SPACE_SAVED_SCREENSHOTS)await other.screenshot({path:process.env.SPACE_SAVED_SCREENSHOTS+'/split.png',animations:'disabled'});
  await other.getByRole('button',{name:'Close split view'}).click();
  const intro=other.getByRole('region',{name:'About Saved'});
  await intro.getByRole('button',{name:'Clear All Saved'}).click();
  await other.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();
  await intro.getByRole('button',{name:'Dismiss Saved introduction'}).click();
  await expect(intro).toHaveCount(0);await other.reload();
  await expect(other.getByText('A note from our DM')).toBeVisible();await expect(intro).toHaveCount(0);
  await other.getByRole('button',{name:'Clean up'}).click();await other.getByRole('menuitem',{name:'Remove all saved items'}).click();
  await other.getByRole('dialog').getByRole('button',{name:'Remove all',exact:true}).click();
  await expect(other.getByText('Nothing saved yet')).toBeVisible();
});

test('Directories opens real profiles, filters channels, and tracks workspace invitations', {timeout:120_000}, async t=>{
  const {alice,pool,seed,web}=await openWorkspace(t);
  const captures=process.env.SPACE_DIRECTORY_SCREENSHOTS;
  const me=(await (await alice.request.get(web+'/v1/me')).json()).id;
  await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.workspace_id,me]);
  await pool.query("UPDATE users SET title='Designer' WHERE id=$1",[me]);
  await alice.setViewportSize({width:1512,height:834});
  await alice.getByRole('button',{name:'Directories',exact:true}).click();
  const main=alice.getByRole('main').filter({has:alice.getByRole('heading',{name:'Directories',exact:true})});
  const card=main.getByRole('button',{name:'View alice’s profile'});
  await expect(card).toBeVisible();
  if(captures)await alice.screenshot({path:captures+'/space-people.png'});
  await card.click();await expect(alice.getByRole('region',{name:'Profile',exact:true})).toBeVisible();
  await alice.getByRole('region',{name:'Profile',exact:true}).getByRole('button',{name:/close/i}).first().click();
  await main.getByRole('button',{name:'Title',exact:true}).click();await alice.getByRole('menuitem',{name:'Designer',exact:true}).click();
  await expect(card).toBeVisible();await expect(main.getByRole('button',{name:'View bob’s profile'})).toHaveCount(0);
  await main.getByRole('tab',{name:'Channels',exact:true}).click();
  await expect(main.getByRole('button',{name:'Open general'})).toBeVisible();
  if(captures)await alice.screenshot({path:captures+'/space-channels.png'});
  await main.getByRole('button',{name:'Filter channels'}).click();
  await alice.getByRole('menuitem',{name:'Other channels'}).click();
  await expect(main.getByRole('button',{name:'Open general'})).toHaveCount(0);
  await main.getByRole('button',{name:'Create Channel',exact:true}).click();
  const create=alice.getByRole('dialog',{name:'Create a channel'});
  await expect(create).toBeVisible();
  await create.getByRole('textbox',{name:'Channel name'}).fill('directory-project');
  await create.getByRole('button',{name:/^create/i}).click();
  await expect(create).toHaveCount(0);await expect(main).toHaveCount(0);
  await alice.getByRole('button',{name:'Directories',exact:true}).click();
  await main.getByRole('tab',{name:'External',exact:true}).click();
  await expect(main.getByText('No guests in this directory yet')).toBeVisible();
  if(captures)await alice.screenshot({path:captures+'/space-external.png'});
  await main.getByRole('tab',{name:'Invitations',exact:true}).click();
  await expect(main.getByText('Track your invitations')).toBeVisible();
  if(captures)await alice.screenshot({path:captures+'/space-invitations.png'});
  await main.getByRole('button',{name:'Manage invitations'}).click();
  const invitations=alice.getByRole('dialog',{name:'Invitations',exact:true});
  await expect(invitations.getByRole('button',{name:'Invite by email'})).toBeEnabled();
});
