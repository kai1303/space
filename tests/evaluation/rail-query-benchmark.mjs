import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Run against a local production build. HTTP, Socket.IO and identity are synthetic.
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:4173').origin;
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the loopback preview server.');
const date = new Date(Date.now() - 5000).toISOString();
const user = { id: 'user', name: 'Test User', emailVerified: true, email: 'test@example.invalid' };
const message = {
  id: 'prior', sequence: '1', thread_id: 'previous', channel_id: 'first', text: 'Earlier message',
  author: { kind: 'human', id: user.id, name: user.name }, created_at: date, client_message_id: null, task_id: null,
};
const dm = {
  id: 'dm', name: 'Morgan', workspace_id: 'workspace', kind: 'direct', joined: true,
  participants: [{ id: 'person', name: 'Morgan' }],
  last_message: { created_at: date, author_name: 'Morgan', text: 'The mockups are ready' },
};
const notification = { id: '12', kind: 'mention', author_name: 'Morgan', channel_name: 'design', channel_id: 'first', message_id: 'sample', text: 'Can you review the mockups?', created_at: date };
const session = { id: 'agent-session', title: 'Review session', agent_name: 'Preview agent', channel_id: 'first', workspace_id: 'workspace', managed: true, state: 'active', owner_id: user.id, created_at: date };
const todo = { id: 'item', title: 'Review the design', remind_at: new Date(Date.now() + 86400000).toISOString(), completed: false, archived: false, deleted: false, created_at: date, updated_at: date };
const file = { id: 'file-1', filename: 'Brief.pdf', channel_name: 'design', channel_id: 'first', message_id: 'sample', created_at: date, starred: false };
const pageOf = (...items) => ({ items, next_cursor: null });

function reply(url, request) {
  const path = url.pathname.slice('/v1'.length);
  if (path === '/auth/get-session') return { user, session: { id: 'session', userId: user.id, expiresAt: new Date(Date.now() + 3600000).toISOString() } };
  if (path === '/me') return { id: user.id, display_name: user.name };
  if (path === '/workspaces') return pageOf({ id: 'workspace', name: 'Benchmark workspace' });
  if (path.endsWith('/direct-messages')) return pageOf(dm);
  if (path.endsWith('/notifications')) return { ...pageOf(notification), unread_count: 1, latest_id: notification.id };
  if (path.endsWith('/hub/files')) return url.searchParams.get('starred') === 'true' && !file.starred ? pageOf() : pageOf(file);
  if (path.endsWith('/hub/files/file-1/star')) {
    assert.equal(request.method(), 'POST');
    file.starred = request.postDataJSON().active;
    return { starred: file.starred };
  }
  if (path.endsWith('/hub/todos')) return pageOf(todo);
  if (path.endsWith('/agent-sessions')) return pageOf(session);
  if (path.endsWith('/channels')) return pageOf({ id: 'first', name: 'first', workspace_id: 'workspace', joined: true });
  if (path.endsWith('/messages')) return { messages: [message], has_older: false, has_newer: false, older_cursor: '1', newer_cursor: '1', event_cursor: '1' };
  if (path.endsWith('/history')) return { events: [], cursor: '1' };
  if (path.endsWith('/permissions')) return { revision: '1', capabilities: { post: true, reply: true } };
  if (path.includes('mention')) return { ...pageOf(), unread_count: 0, member_count: 1 };
  if (path.includes('/unread')) return { channels: [], workspace_id: 'workspace' };
  if (/starred|participants|installations|\/hub\/|\/direct|session/.test(path)) return pageOf();
  return [];
}

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, serviceWorkers: 'block' });
  const counts = {};
  const requests = {};
  let phase = 'startup';
  let socket;
  const workspaceReady = Promise.withResolvers();
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/v1/')) return route.continue();
    const step = phase.split('/')[0];
    counts[step] ??= { GET: 0, writes: 0 };
    counts[step][request.method() === 'GET' ? 'GET' : 'writes']++;
    requests[phase] ??= {};
    const key = [request.method(), url.pathname + url.search].join(' ');
    requests[phase][key] = (requests[phase][key] ?? 0) + 1;
    await route.fulfill({ json: reply(url, request) });
  });
  await page.routeWebSocket('**/*', ws => {
    if (new URL(ws.url()).host !== new URL(origin).host || !new URL(ws.url()).pathname.startsWith('/socket.io/')) return ws.close();
    socket = ws;
    ws.send('0' + JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 60000, pingTimeout: 20000, maxPayload: 1000000 }));
    ws.onMessage(raw => {
      const packet = String(raw);
      if (packet.startsWith('40')) return ws.send('40{"sid":"fixture"}');
      const ack = /^42(\d+)\[/.exec(packet);
      if (ack) {
        ws.send('43' + ack[1] + '[{"data":{}}]');
        const [event, data] = JSON.parse(packet.slice(ack[0].length - 1));
        if (event === 'updates.subscribe' && data.scope === 'workspace') workspaceReady.resolve();
      }
    });
  });
  await page.goto(origin + '/chat');
  page.setDefaultTimeout(7000);
  const rail = page.getByRole('navigation', { name: 'Main navigation' });
  const card = page.locator('.rail-peek');
  const content = value => card.getByText(value, { exact: true }).first().waitFor();
  const open = async name => {
    await rail.getByRole('button', { name: name === 'Activity' ? /^Activity/ : name, exact: true }).hover();
    await card.getByRole('heading').first().waitFor();
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'hidden' });
    await rail.getByRole('link', { name: 'Home' }).hover();
  };
  await rail.waitFor();
  await page.getByText(message.text, { exact: true }).waitFor();
  const home = page.url();
  await page.bringToFront();
  await Promise.race([
    workspaceReady.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Workspace subscription did not start')), 7000).unref()),
  ]);
  await page.waitForLoadState('networkidle');

  for (const cycle of ['cold', 'warm1', 'warm2']) {
    counts[cycle] = { GET: 0, writes: 0 };
    for (const name of ['Spacebot', 'DMs', 'Activity', 'Files', 'To-dos', 'Admin']) {
      phase = cycle + '/' + name;
      await open(name);
      if (name === 'Spacebot') {
        const recent = card.getByRole('button', { name: /Review session/ });
        await recent.waitFor();
        await card.getByRole('tab', { name: 'Agenda' }).click();
        await content(todo.title);
        await card.getByRole('tab', { name: 'Overview' }).click();
        await recent.waitFor();
      }
      if (name === 'DMs' || name === 'Activity') {
        const sample = name === 'DMs' ? 'Morgan: The mockups are ready' : notification.text;
        await content(sample);
        for (let toggle = 0; toggle < 2; toggle++) {
          await card.getByRole('button', { name: 'Unreads' }).click();
          await content(sample);
        }
      }
      if (name === 'Files') {
        await content(file.filename);
        const filter = card.getByRole('button', { name: 'Starred' });
        await filter.click();
        await content('No starred files yet.');
        await filter.click();
        await content(file.filename);
      }
      if (name === 'To-dos') await content(todo.title);
      await close();
      assert.equal(page.url(), home);
    }
    assert.equal(counts[cycle].writes, 0);
  }

  phase = 'event/open';
  await open('Files');
  await content(file.filename);
  phase = 'event/refresh';
  file.filename = 'Revised.pdf';
  socket.send('42' + JSON.stringify(['updates.changed', { scope: 'workspace', id: 'workspace' }]));
  await content(file.filename);
  await page.waitForTimeout(200);
  await close();

  phase = 'mutation/prepare';
  await open('Files');
  await content(file.filename);
  const starredFilter = card.getByRole('button', { name: 'Starred' });
  await starredFilter.click();
  await content('No starred files yet.');
  await starredFilter.click();
  await content(file.filename);
  phase = 'mutation/write';
  await card.getByRole('button', { name: 'More actions for Revised.pdf' }).click();
  await card.getByRole('menuitem', { name: 'Star file' }).click();
  await starredFilter.click();
  await content(file.filename);
  assert.equal(await starredFilter.getAttribute('aria-pressed'), 'true');
  assert.equal(file.starred, true);
  assert.equal(counts.mutation.writes, 1);
  await close();
  console.log(JSON.stringify({ counts, requests }, null, 2));
} finally {
  await browser.close();
}
