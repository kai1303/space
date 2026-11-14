import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { Pool } from 'pg';
import { migrate } from '@space/postgres/migrate';
import { bootstrap } from '@space/postgres/bootstrap';
import { ChatStore } from '@space/postgres/chat';
import { PostgresStore } from '@space/postgres/store';
import { EventBus } from '@space/events';
import { EventBridge } from '@space/event-service/bridge';
import { createApi } from '@space/server/api';
import { createAssetStorageFromEnv } from '@space/server/storage';
import { readFile } from 'node:fs/promises';
import { createAuthentication } from '@space/server/auth';

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r, j) => s.close((e) => (e ? j(e) : r())));
  return port;
}
async function terminate(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

test(
  'encrypted DMs enroll devices, verify codes and replay private formatted text across browser sessions',
  { timeout: 150_000 },
  async (t) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
    const schema = `encrypted_dm_browser_${randomBytes(6).toString('hex')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: scoped.toString() });
    const natsUrl = process.env.NATS_URL ?? 'nats://127.0.0.1:54222';
    const bridge = new EventBridge({
      databaseUrl: scoped.toString(),
      natsUrl,
      schema,
    });
    const webPort = await freePort(),
      web = `http://127.0.0.1:${webPort}`;
    const auth = createAuthentication(pool, {
      secret: randomBytes(32).toString('hex'),
      baseURL: web,
    });
    const storage = createAssetStorageFromEnv({
      ...process.env,
      ASSET_STORAGE_BUCKET: 'space-encrypted-dm-browser-tests',
      ASSET_STORAGE_ORIGINS: web,
    });
    if (!storage) throw Error('ASSET_STORAGE_* required');
    await storage.initialize();
    const app = createApi(new PostgresStore(pool), {
      auth,
      storage,
      realtime: { eventUrl: natsUrl },
    });
    let vite: ChildProcess | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    t.after(async () => {
      await browser?.close();
      if (vite) await terminate(vite);
      await app.close();
      await bridge.close();
      const files = await pool.query('SELECT object_key,staging_key FROM assets').catch(() => ({ rows: [] }));
      for (const file of files.rows) {
        await storage.remove(file.object_key);
        await storage.remove(file.staging_key);
      }
      await pool.end();
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.query(
            'SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1',
            [bridge.slot],
          );
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== '55006' || attempt >= 6) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
        }
      }
      await admin.query(`DROP PUBLICATION IF EXISTS "${bridge.publication}"`);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await bridge.start();
    const seed = await bootstrap(pool),
      chat = new ChatStore(pool);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const webDirectory = fileURLToPath(new URL('../../apps/web', import.meta.url));
    vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
      cwd: webDirectory,
      env: { ...process.env, SPACE_API_URL: address },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Vite startup timeout: ' + output)), 20000);
      vite!.stdout!.on('data', (chunk) => {
        output += chunk;
        if (stripVTControlCharacters(output).includes('Local:')) {
          clearTimeout(timer);
          resolve();
        }
      });
      vite!.stderr!.on('data', (chunk) => {
        output += chunk;
      });
      vite!.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Vite exited: ' + output));
      });
    });
    browser = await chromium.launch({ headless: true });
    async function openMember(name: string) {
      const context = await browser!.newContext({
        viewport: { width: 1280, height: 800 },
      });
      const signup = await context.request.post(web + '/v1/auth/sign-up/email', {
        data: {
          name,
          email: name + '-' + schema + '@example.test',
          password: randomBytes(18).toString('hex'),
        },
        headers: { origin: web },
      });
      assert.equal(signup.status(), 200);
      const actor = (await signup.json()).user.id;
      await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [
        seed.workspace_id,
        actor,
      ]);
      await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES($1,$2,$3)', [
        seed.workspace_id,
        seed.channel_id,
        actor,
      ]);
      return { page: await context.newPage(), context, actor };
    }
    const alice = await openMember('Alice'),
      bob = await openMember('Bob');
    const dm = await chat.directMessages.open(alice.actor, seed.workspace_id, {
      user_id: bob.actor,
    });
    await chat.directMessages.open(bob.actor, seed.workspace_id, {
      user_id: alice.actor,
    });
    const url = web + '/chat?workspace=' + seed.workspace_id + '&channel=' + dm.id;
    async function openDetails(member: typeof alice) {
      await member.page.getByRole('button', { name: 'More conversation actions' }).click();
      await member.page.getByRole('menuitem', { name: 'Conversation details' }).click();
    }
    async function enroll(member: typeof alice) {
      await openDetails(member);
      await member.page.getByRole('button', { name: 'Register this device' }).click();
      await expect(member.page.getByText('This device is registered for this DM.')).toBeVisible({
        timeout: 20000,
      });
      await member.page.keyboard.press('Escape');
    }
    for (const member of [alice, bob]) await member.page.goto(url);
    await enroll(alice);
    await enroll(bob);
    await openDetails(alice);
    await openDetails(bob);
    const code = (member: typeof alice) => member.page.locator('.dm-encryption-settings code');
    await expect(code(alice)).toHaveText(/[0-9a-f]{8} /, { timeout: 10000 });
    assert.equal(await code(alice).innerText(), await code(bob).innerText());
    await alice.page.getByLabel('The codes match').check();
    await alice.page.getByRole('button', { name: 'Enable encrypted messages' }).click();
    await expect(bob.page.getByRole('button', { name: 'Trust these devices' })).toBeVisible();
    await bob.page.getByLabel('The codes match').check();
    await bob.page.getByRole('button', { name: 'Trust these devices' }).click();
    for (const member of [alice, bob]) {
      await expect(
        member.page.getByText('Verified devices. New messages are end-to-end encrypted.'),
      ).toBeVisible();
      await member.page.keyboard.press('Escape');
    }
    await bob.page.close();
    const marker = 'Private message ' + randomUUID(),
      frames: string[] = [];
    const bus = new EventBus(natsUrl, schema);
    await bus.start();
    t.after(() => bus.close());
    const brokerEvents: string[] = [];
    await bus.subscribe('chat.changed.' + dm.id, { maxPending: 4 }, async (delivery) => {
      brokerEvents.push(JSON.stringify(delivery.event));
      await delivery.ack();
    });
    // Reconnect first so the test observes outgoing Socket.IO frames before Send.
    alice.page.on('websocket', (ws) => ws.on('framesent', (f) => frames.push(String(f.payload))));
    await alice.page.reload();
    const editor = alice.page.locator(
      '[contenteditable="true"][data-placeholder="Write an encrypted message…"]',
    );
    await expect(editor).toBeVisible();
    await editor.click();
    await alice.page.getByRole('button', { name: 'Bold', exact: true }).click();
    await editor.pressSequentially(marker);
    await expect(editor.locator('strong,b')).toHaveText(marker);
    const fileName = 'secret-' + randomUUID() + '.txt',
      imageName = 'photo-' + randomUUID() + '.png';
    const fileBytes = Buffer.from('Private attachment ' + randomUUID());
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    const uploadRequests: string[] = [];
    alice.page.on('request', (r) => {
      if (r.method() === 'POST') uploadRequests.push(r.postData() ?? '');
    });
    // Exercise the existing + picker and queued send while encrypted uploads finish.
    await alice.page.getByRole('button', { name: 'Add to message', exact: true }).click();
    const choosing = alice.page.waitForEvent('filechooser');
    await alice.page.getByRole('menuitem', { name: 'Upload from computer' }).click();
    await (
      await choosing
    ).setFiles([
      { name: fileName, mimeType: 'text/plain', buffer: fileBytes },
      { name: imageName, mimeType: 'image/png', buffer: imageBytes },
    ]);
    await editor.press('Enter');
    await expect(alice.page.getByRole('article').getByText(marker, { exact: true })).toBeVisible({
      timeout: 15000,
    });
    assert.ok(frames.some((f) => f.includes('message.send') && f.includes('ciphertext')));
    assert.ok(frames.every((f) => !f.includes(marker)));
    const returned = await bob.context.newPage();
    await returned.goto(url);
    const received = returned.getByRole('article').filter({ hasText: marker });
    await expect(received).toHaveCount(1, { timeout: 15000 });
    await expect(received.locator('strong,b').filter({ hasText: marker })).toBeVisible();
    await expect(returned.getByText('End-to-end encrypted messages', { exact: true })).toBeVisible();
    await expect(received.getByText(fileName, { exact: true })).toBeVisible();
    const image = received.getByRole('img', { name: imageName, exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await received.getByRole('button', { name: 'Preview ' + imageName }).click();
    const preview = returned.getByRole('dialog', { name: imageName });
    await expect(preview.getByRole('img', { name: imageName })).toBeVisible();
    await returned.keyboard.press('Escape');
    const downloadEvent = returned.waitForEvent('download');
    await received.getByRole('button', { name: 'Download ' + fileName }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), fileName);
    assert.deepEqual(await readFile((await download.path())!), fileBytes);
    const storedFiles = await pool.query('SELECT * FROM assets WHERE channel_id=$1', [dm.id]);
    assert.equal(storedFiles.rowCount, 2);
    for (const file of storedFiles.rows) {
      assert.equal(file.name, 'Encrypted file');
      assert.equal(file.type, 'application/octet-stream');
      assert.equal(file.encrypted, true);
      const wrongActor = await bob.context.request.get(web + '/v1/assets/' + file.id + '/encrypted-content', {
        headers: { 'X-Expected-Actor': alice.actor },
      });
      assert.equal(wrongActor.status(), 409);
      const bytes = await storage.read(file.object_key, file.size);
      assert.ok(!Buffer.from(bytes).equals(fileBytes));
      assert.ok(!Buffer.from(bytes).equals(imageBytes));
      const thumbnail = await bob.context.request.get(web + '/v1/assets/' + file.id + '/thumbnail');
      assert.equal(thumbnail.status(), 415);
    }
    for (const request of uploadRequests) {
      assert.ok(
        !request.includes(fileName) &&
          !request.includes(imageName) &&
          !request.includes(fileBytes.toString()),
      );
    }
    const searchRequests: string[] = [];
    returned.on('request', (r) => searchRequests.push(decodeURIComponent(r.url()) + (r.postData() ?? '')));
    await returned.getByRole('button', { name: 'Search in Alice' }).click();
    const search = returned.getByRole('dialog', {
      name: 'Search this conversation on this device',
    });
    await search.getByRole('searchbox').fill(marker);
    await search.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(search.getByRole('button', { name: marker })).toBeVisible();
    await search.getByRole('searchbox').fill(fileName);
    await search.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(search.getByRole('button', { name: fileName })).toBeVisible();
    assert.ok(searchRequests.every((r) => !r.includes(marker) && !r.includes(fileName)));
    await expect.poll(() => brokerEvents.some((event) => event.includes('workspace-messages:'))).toBe(true);
    assert.ok(brokerEvents.every((event) => !event.includes(marker)));
    const notifications = await bob.context.request.get(
      web + '/v1/workspaces/' + seed.workspace_id + '/notifications',
    );
    const previews = await notifications.text();
    assert.equal(notifications.status(), 200);
    assert.ok(previews.includes('Encrypted message') && !previews.includes(marker));
    const stored = await pool.query('SELECT text,document,encrypted FROM messages WHERE channel_id=$1', [
      dm.id,
    ]);
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].text, 'Encrypted message');
    assert.equal(stored.rows[0].document, null);
    assert.ok(stored.rows[0].encrypted.ciphertext);
    assert.ok(!JSON.stringify(stored.rows).includes(marker));
    await returned.keyboard.press('Escape');
    const fileOnly = 'no-caption-' + randomUUID() + '.txt';
    await alice.page.route(
      '**/v1/channels/' + dm.id + '/assets',
      async (route) => {
        assert.deepEqual(route.request().postDataJSON(), {
          name: 'Encrypted file',
          size: fileBytes.length,
          type: 'application/octet-stream',
          encrypted: true,
        });
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'temporarily_unavailable' }),
        });
      },
      { times: 1 },
    );
    await alice.page.locator('input[type=file]').last().setInputFiles({
      name: fileOnly,
      mimeType: 'text/plain',
      buffer: fileBytes,
    });
    await alice.page.getByRole('button', { name: 'Retry upload ' + fileOnly }).click();
    const extra = Array.from({ length: 4 }, (_, index) => ({
      name: 'extra-' + index + '.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('extra ' + index),
    }));
    await alice.page.locator('input[type=file]').last().setInputFiles(extra);
    await alice.page.getByRole('button', { name: 'Send now', exact: true }).click();
    await expect(returned.getByRole('article').getByText(fileOnly, { exact: true })).toBeVisible({
      timeout: 15000,
    });
    for (const item of extra)
      await expect(returned.getByRole('article').getByText(item.name, { exact: true })).toBeVisible();
    const pendingDraft = 'Unsent private draft ' + randomUUID();
    const unsentFile = 'draft-only-' + randomUUID() + '.txt';
    await editor.fill(pendingDraft);
    await alice.page.locator('input[type=file]').last().setInputFiles({
      name: unsentFile, mimeType:'text/plain', buffer:fileBytes,
    });
    const draftPath = web + '/v1/composer-drafts/' + encodeURIComponent('encrypted:' + dm.id);
    await expect.poll(async () => (await (await alice.page.request.get(draftPath)).json()).value?.asset_ids?.length).toBe(1);
    const { value } = await (await alice.page.request.get(draftPath)).json();
    assert.deepEqual(Object.keys(value).sort(), ['asset_ids','ciphertext']);
    assert.ok(!JSON.stringify(value).includes(pendingDraft) && !JSON.stringify(value).includes(unsentFile));
    assert.equal((await (await returned.request.get(draftPath)).json()).value, null);
    await openDetails(alice);
    await alice.page.getByRole('button', {name:'Show device linking code'}).click();
    const linkingCode = await alice.page.locator('.dm-encryption-settings code').filter({hasText:/^[a-f0-9]{64}$/}).textContent();
    assert.ok(linkingCode);
    await alice.page.keyboard.press('Escape');
    const linked = await browser.newContext({viewport:{width:1280,height:800}});
    await linked.addCookies(await alice.context.cookies());
    const second = await linked.newPage();
    await second.goto(url);
    const secondEditor = second.locator('[data-placeholder="Write an encrypted message…"]');
    await expect(secondEditor).toHaveText('');
    await openDetails({...alice, page:second});
    await second.getByLabel('Device linking code').fill(linkingCode);
    await second.getByRole('button', {name:'Register this device'}).click();
    await expect(second.getByText('This device is registered for this DM.')).toBeVisible();
    await second.keyboard.press('Escape');
    await expect(secondEditor).toHaveText(pendingDraft, {timeout:15000});
    await expect(second.getByRole('button', {name:'Remove ' + unsentFile})).toBeVisible();
    const written = second.waitForResponse(response => response.url() === draftPath && response.request().method() === 'PUT',
      {timeout:15000});
    await secondEditor.click();
    await secondEditor.press('End');
    await secondEditor.pressSequentially(' from linked device');
    await expect(secondEditor).toHaveText(pendingDraft + ' from linked device');
    const synced = await written;
    assert.ok(synced.ok(), await synced.text());
    await expect(editor).toHaveText(pendingDraft + ' from linked device', {timeout:15000});
    await expect(returned.locator('[data-placeholder="Write an encrypted message…"]')).toHaveText('');
    await linked.close();
  },
);
