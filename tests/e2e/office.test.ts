import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {chromium,expect} from '@playwright/test';
import {Pool} from 'pg';
import {migrate} from '@space/postgres/migrate';
import {bootstrap} from '@space/postgres/bootstrap';
import {PostgresStore} from '@space/postgres/store';
import {createApi} from '@space/server/api';
import {createAuthentication} from '@space/server/auth';
import {createAssetStorageFromEnv} from '@space/server/storage';

async function freePort():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return port;}
async function terminate(child:ChildProcess){if(child.exitCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}

const names=['Budget.xlsx','Runbook.docx','Notes.odt','Slides.pptx','OpenSheet.ods','OpenSlides.odp'];

// Needs a real ONLYOFFICE Document Server and SeaweedFS; see docs/architecture/assets.md.
test('members preview all Office formats, co-edit a shared document and reopen the saved result', {timeout:300_000}, async t=>{
  const databaseUrl=process.env.TEST_DATABASE_URL;if(!databaseUrl)throw new Error('TEST_DATABASE_URL required');
  const url=process.env.ONLYOFFICE_URL,secret=process.env.ONLYOFFICE_JWT_SECRET;
  if(!url||!secret)throw new Error('ONLYOFFICE_URL and ONLYOFFICE_JWT_SECRET required');
  const apiPort=await freePort();
  const callbackHost=process.env.OFFICE_TEST_CALLBACK_HOST ?? 'host.docker.internal';
  const office={url,secret,callbackBase:`http://${callbackHost}:${apiPort}`};
  const storage=createAssetStorageFromEnv();if(!storage)throw new Error('ASSET_STORAGE_* required');
  const schema=`office_browser_${randomBytes(6).toString('hex')}`;
  const admin=new Pool({connectionString:databaseUrl});
  const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema}`);
  const pool=new Pool({connectionString:scoped.toString()});
  const natsUrl=process.env.NATS_URL??'nats://127.0.0.1:54222';
  const webPort=await freePort(),web=`http://127.0.0.1:${webPort}`;
  const auth=createAuthentication(pool,{secret:randomBytes(32).toString('hex'),baseURL:web});
  const app=createApi(new PostgresStore(pool),{auth,storage,office,allowDevelopmentTokens:true,realtime:{eventUrl:natsUrl}});
  let vite:ChildProcess|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  t.after(async()=>{
    await browser?.close();if(vite)await terminate(vite);await app.close();
    const {rows}=await pool.query<{object_key:string;staging_key:string}>('SELECT object_key,staging_key FROM assets').catch(()=>({rows:[]}));
    for(const row of rows){await storage.remove(row.object_key);await storage.remove(row.staging_key);}
    await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);
  const seed=await bootstrap(pool);
  // A private channel proves a workspace member outside it cannot open the viewer.
  await pool.query('UPDATE channels SET private=true WHERE id=$1',[seed.channel_id]);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[seed.channel_id,seed.collaborator_id]);
  const address=await app.listen({host:process.env.OFFICE_TEST_BIND_HOST ?? '127.0.0.1',port:apiPort});
  const webDirectory=fileURLToPath(new URL('../../apps/web',import.meta.url));
  vite=spawn('pnpm',['exec','vite','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{cwd:webDirectory,env:{...process.env,SPACE_API_URL:address},stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Vite startup timeout: '+output)),20000);vite!.stdout!.on('data',chunk=>{output+=chunk;if(stripVTControlCharacters(output).includes('Local:')){clearTimeout(timer);resolve();}});vite!.stderr!.on('data',chunk=>{output+=chunk;});vite!.once('exit',()=>{clearTimeout(timer);reject(new Error('Vite exited: '+output));});});
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const signup=await context.request.post(web+'/v1/auth/sign-up/email',{data:{name:'Office tester',email:schema+'@example.test',password:randomBytes(24).toString('hex')},headers:{origin:web}});
  assert.equal(signup.status(),200);
  const actor=(await signup.json()).user.id;
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[seed.workspace_id,actor]);
  await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)',[seed.workspace_id,seed.channel_id,actor]);
  async function post(path:string,data:unknown){const r=await context.request.post(web+'/v1'+path,{data,headers:{origin:web}});assert(r.ok(),path+' '+r.status()+' '+(r.ok()?'':await r.text()));return r.json();}

  for(const name of names){
    const file=await readFile(new URL('../fixtures/office/'+name,import.meta.url));
    const {asset,upload}=await post('/channels/'+seed.channel_id+'/assets',{name,size:file.length,type:'application/octet-stream'});
    const form=new FormData();for(const [key,value] of Object.entries(upload.fields as Record<string,string>))form.append(key,value);form.append('file',new Blob([file]),name);
    const uploaded=await fetch(upload.url,{method:'POST',body:form});assert(uploaded.ok,'upload '+uploaded.status);
    await post('/assets/'+asset.id+'/complete',{});
    await post('/channels/'+seed.channel_id+'/messages',{client_message_id:randomUUID(),text:'',asset_ids:[asset.id]});
    const path='/v1/assets/'+asset.id+'/office-session';
    const session=await context.request.get(web+path);assert.equal(session.status(),200,name+' '+await session.text());
    const {config}=await session.json();
    assert.equal(config.editorConfig.mode,'view');
    assert.equal(config.document.permissions.edit,false);
    assert.equal(config.document.permissions.chat,false);
    assert.equal(config.editorConfig.customization.plugins,false);
    const outsider=await app.inject({url:path,headers:{authorization:'Bearer '+seed.collaborator_token}});
    assert.equal(outsider.statusCode,404,name);
  }

  const page=await context.newPage();
  await page.goto(web+'/chat?workspace='+seed.workspace_id+'&channel='+seed.channel_id);
  for(const name of names){
    await page.getByRole('button',{name:'Open '+name,exact:true}).click({timeout:30000});
    const dialog=page.getByRole('dialog',{name});
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.asset-office-preview iframe')).toHaveCount(1);
    await expect(dialog.locator('.asset-office-preview')).toHaveAttribute('aria-busy','false',{timeout:45000});
    const viewer=page.frameLocator('.asset-office-preview iframe');
    await expect(viewer.getByText('Plugins',{exact:true}).locator('visible=true')).toHaveCount(0);
    await expect(viewer.locator('#left-btn-chat:visible')).toHaveCount(0);
    if(name==='Budget.xlsx'){
      // Switching sheets proves the read-only viewer is interactive, not a static image.
      await viewer.locator('[tabtitle=Forecast]').click({position:{x:20,y:14}});
      const sheet=page.frames().find(frame=>frame.url().includes('/spreadsheeteditor/'));
      assert(sheet,'spreadsheet editor frame');
      await expect.poll(()=>sheet.evaluate(()=>(window as unknown as {Asc:{editor:{asc_getActiveWorksheetIndex():number}}}).Asc.editor.asc_getActiveWorksheetIndex())).toBe(1);
    }
    await dialog.getByRole('button',{name:'Close dialog'}).click();
  }

  const peer = await browser.newContext({viewport:{width:1440,height:1000}});
  const second = await peer.request.post(web+'/v1/auth/sign-up/email',{data:{name:'Second editor',email:schema+'-peer@example.test',password:randomBytes(24).toString('hex')},headers:{origin:web}});
  assert.equal(second.status(),200);
  const peerId = (await second.json()).user.id;
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[seed.workspace_id,peerId]);
  await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)',[seed.workspace_id,seed.channel_id,peerId]);
  const assetId=(await pool.query("SELECT id FROM assets WHERE name='Runbook.docx'")).rows[0].id;
  const assetUrl=web+'/v1/assets/'+assetId;
  assert.equal((await peer.request.get(assetUrl+'/office-session?mode=edit')).status(),403);
  await page.getByRole('button',{name:'Open Runbook.docx',exact:true}).click();
  await page.getByRole('button',{name:'Channel editing off'}).click();
  await expect(page.getByRole('button',{name:'Channel editing on'})).toBeVisible();
  const otherPage=await peer.newPage();
  await otherPage.goto(web+'/chat?workspace='+seed.workspace_id+'&channel='+seed.channel_id);
  await otherPage.getByRole('button',{name:'Open Runbook.docx',exact:true}).click();
  for (const editor of [page,otherPage]) {
    await editor.getByRole('button',{name:'Edit',exact:true}).click();
    await expect(editor.getByRole('region',{name:'Office document editor'})).toHaveAttribute('aria-busy','false',{timeout:45000});
  }
  // Both browser contexts remain connected while they type into the same document.
  for (const [editor,marker] of [[page,'FirstEditorMarker'],[otherPage,'SecondEditorMarker']] as const) {
    await editor.bringToFront();
    const frame=editor.frameLocator('.asset-office-preview iframe');
    await frame.locator('#id_viewer_overlay').click({position:{x:260,y:160}});
    await editor.keyboard.press('Control+Home');
    await editor.keyboard.insertText(marker);
    const other = editor === page ? otherPage : page;
    const remote = other.frames().find(f => f.url().includes('/documenteditor/'))!;
    await expect.poll(() => remote.evaluate(() =>
      (window as unknown as {Asc:{editor:{pluginMethod_GetFileHTML():string}}}).Asc.editor.pluginMethod_GetFileHTML().replace(/<[^>]+>/g, '')),
      {timeout:20000, message:'The other editor receives '+marker+' before closing'}).toContain(marker);
  }
  await page.getByRole('button',{name:'Close dialog'}).click();
  await otherPage.getByRole('button',{name:'Close dialog'}).click();
  await expect.poll(async()=> (await (await context.request.get(assetUrl+'/office-session')).json()).revision,
    {timeout:60000, intervals:[1000,2000]}).toBe(1);
  const dir=await mkdtemp(join(tmpdir(),'space-office-'));
  try {
    const file=join(dir,'saved.docx');
    await writeFile(file,await (await context.request.get(assetUrl+'/download')).body());
    const xml=execFileSync('unzip',['-p',file,'word/document.xml'],{encoding:'utf8'}).replace(/<[^>]+>/g,'');
    assert.match(xml,/FirstEditorMarker/);
    assert.match(xml,/SecondEditorMarker/);
    const original=await (await context.request.get(assetUrl+'/download?original=1')).body();
    assert.deepEqual(original,await readFile(new URL('../fixtures/office/Runbook.docx',import.meta.url)));
  } finally { await rm(dir,{recursive:true,force:true}); }
  await page.getByRole('button',{name:'Open Runbook.docx',exact:true}).click();
  await expect(page.getByText('Viewing · Version 2')).toBeVisible();
  await expect(page.getByRole('region',{name:'Office document viewer'})).toHaveAttribute('aria-busy','false',{timeout:45000});
  // Exercise the desktop document route with a deterministic draft. The actual
  // editor, plugin, cursor label, permission check on session open and saves are real.
  let finishDraft: ((result: { replacement: string; message: string }) => void) | undefined;
  let selectedText = '';
  await page.exposeFunction('officeTestDraft', (_goal: string, selection: string) => {
    selectedText = selection;
    return new Promise(resolve => { finishDraft = resolve; });
  });
  await page.addInitScript(`if (window === window.top) window.spaceOffice = {
    ask: (goal, text) => window.officeTestDraft(goal, text),
    openFile: async () => false,
    onClose: handler => {
      window.closeOfficeTestTab = () => handler(() => location.replace('about:blank'));
      return () => { delete window.closeOfficeTestTab; };
    }
  };`);
  await page.goto(web+'/office/file/'+assetId);
  await page.getByRole('button',{name:'Edit', exact:true}).click();
  await expect(page.getByRole('region',{name:'Office document editor'})).toHaveAttribute('aria-busy','false',{timeout:45000});
  const editorFrame = page.frames().find(f=>f.url().includes('/documenteditor/'))!;
  const overlay = editorFrame.locator('#id_viewer_overlay');
  const selectLine = async () => {
    await overlay.click({position:{x:260,y:160}});
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+End');
  };
  await selectLine();
  await page.getByRole('button',{name:'Ask Space AI'}).click();
  await page.getByRole('textbox',{name:'Ask Space AI about the selection'}).fill('Rewrite this text.');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>Boolean(finishDraft)).toBe(true);
  assert.ok(selectedText.trim());
  await overlay.click({position:{x:270,y:170}});
  finishDraft!({replacement:'ConflictMustNotApply',message:'Draft ready.'});
  await expect(page.getByRole('textbox',{name:'Proposed replacement'})).toHaveValue('ConflictMustNotApply');
  const documentHtml = () => editorFrame.evaluate(() =>
    (window as unknown as {Asc:{editor:{pluginMethod_GetFileHTML():string}}}).Asc.editor.pluginMethod_GetFileHTML());
  assert.ok(!(await documentHtml()).includes('ConflictMustNotApply'));
  finishDraft = undefined;
  await selectLine();
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>Boolean(finishDraft)).toBe(true);
  finishDraft!({replacement:'SpaceAgentApplied',message:'Draft ready.'});
  const label = editorFrame.frameLocator('iframe[src*="/space-agent/index.html"]').getByText('Space AI',{exact:true});
  await expect(label).toBeVisible();
  await expect(page.getByText('Edited the selection.')).toBeVisible();
  await expect(label).toBeHidden();
  const editedText = await documentHtml();
  assert.ok(editedText.includes('SpaceAgentApplied'));
  assert.ok(!editedText.includes('ConflictMustNotApply'));
  await expect(page.getByText('Changes are saved to Space when the last editor closes the document.')).toBeVisible({timeout:30000});
  await page.evaluate('window.closeOfficeTestTab()');
  await page.waitForURL('about:blank');
  await expect.poll(async()=> (await (await context.request.get(assetUrl+'/office-session')).json()).revision,
    {timeout:60000, intervals:[1000,2000]}).toBe(2);
  await page.goto(web+'/office/file/'+assetId);
  await expect(page.getByRole('region',{name:'Office document viewer'})).toHaveAttribute('aria-busy','false',{timeout:45000});
  const savedFrame = page.frames().find(f=>f.url().includes('/documenteditor/'))!;
  const saved = await savedFrame.evaluate(() =>
    (window as unknown as {Asc:{editor:{pluginMethod_GetFileHTML():string}}}).Asc.editor.pluginMethod_GetFileHTML().replace(/<[^>]+>/g,''));
  assert.ok(saved.includes('SpaceAgentApplied'));
  assert.ok(!saved.includes(selectedText.trim()), 'the saved selection was replaced');

});
