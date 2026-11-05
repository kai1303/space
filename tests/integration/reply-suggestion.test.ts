import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrap } from '@space/postgres/bootstrap';
import { migrate } from '@space/postgres/migrate';
import { PostgresStore } from '@space/postgres/store';
import { replySuggestionProvider } from '@space/core/reply-suggestion';
import { ChatStore } from '@space/postgres/chat';
import { createApi } from '@space/server/api';

const schema = 'suggest_' + randomUUID().replaceAll('-', '');
const url = process.env.TEST_DATABASE_URL;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
const chat = new ChatStore(pool);
let app: ReturnType<typeof createApi>, calls = 0, context: { speaker: string; text: string }[];
let onGenerate = async () => {};
before(async () => {
  assert.ok(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  process.env.GROQ_API_KEY = 'test-groq-key';
  const realFetch = globalThis.fetch;
  mock.method(globalThis, 'fetch', async (...[input, init]: Parameters<typeof fetch>) => {
    if (String(input) !== 'https://api.groq.com/openai/v1/chat/completions') {
      if (init?.headers && new Headers(init.headers).has('authorization')) throw new Error('unexpected provider endpoint');
      return realFetch(input, init);
    }
    const body = String(init?.body), payload = JSON.parse(body);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-groq-key');
    assert.equal(payload.model, 'openai/gpt-oss-20b');
    assert.equal(payload.reasoning_effort, 'low');
    assert.equal(payload.max_completion_tokens, 256);
    assert.ok(Buffer.byteLength(body) <= 12288);
    context = JSON.parse(payload.messages[1].content);
    calls++;
    await onGenerate();
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Can you send the link?' } }] });
  });
  app = createApi(new PostgresStore(pool), { allowDevelopmentTokens: true });
});
after(async () => {
  mock.restoreAll();
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
test('suggests from the newest 50 visible thread messages and checks access across generation', { timeout: 30_000 }, async () => {
  const a = await bootstrap(pool), outsider = await bootstrap(pool);
  const root = await chat.send(a.owner_id, a.channel_id, { client_message_id: randomUUID(), text: 'Root' });
  for (let i = 1; i <= 51; i++) {
    await chat.send(i % 2 ? a.collaborator_id : a.owner_id, a.channel_id, { thread_id: root.thread_id, client_message_id: randomUUID(), text: `Message ${i}` });
  }
  const session = randomUUID();
  await pool.query("INSERT INTO agent_sessions(id,workspace_id,installation_id,origin_thread_id,title,managed) VALUES($1,$2,$3,$4,'Private',true)", [session,a.workspace_id,a.installation_id,root.thread_id]);
  const task = await new PostgresStore(pool).createTask(a.owner_id, { workspace_id: a.workspace_id, thread_id: root.thread_id, installation_id: a.installation_id, goal: 'Internal task', skill: 'demo.echo' }, randomUUID());
  await pool.query("INSERT INTO messages(id,workspace_id,channel_id,thread_id,installation_id,agent_session_id,task_id,text) VALUES($1,$2,$3,$4,$5,$6,$7,'Private content')", [randomUUID(),a.workspace_id,a.channel_id,root.thread_id,a.installation_id,session,task.id]);
  const suggest = (token: string) => app.inject({ method: 'POST', url: `/v1/threads/${root.thread_id}/reply-suggestion`, headers: { authorization: `Bearer ${token}` }, payload: {} });
  assert.equal((await suggest(outsider.owner_token)).statusCode, 404);
  assert.equal(calls, 0);
  const result = await suggest(a.owner_token);
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { suggestion: 'Can you send the link?' });
  assert.deepEqual(context.map(m => m.text), Array.from({ length: 50 }, (_, i) => `Message ${i + 2}`));
  assert.equal(context[0]!.speaker, 'me');
  assert.deepEqual((await suggest(a.owner_token)).json(), result.json());
  assert.equal(calls, 1, 'refocusing an unchanged thread must reuse the suggestion');
  await chat.send(a.collaborator_id, a.channel_id, { thread_id: root.thread_id, client_message_id: randomUUID(), text: 'Updated question' });
  let entered!: () => void, release!: () => void;
  const generating = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  onGenerate = async () => { entered(); await paused; };
  const first = suggest(a.owner_token).then(response => response.statusCode);
  try {
    await generating;
    assert.equal((await suggest(a.owner_token)).statusCode, 429);
  } finally { release(); }
  assert.equal(await first, 200);
  assert.equal(calls, 2, 'a new message must generate a fresh reply');
  assert.equal(context.at(-1)!.text, 'Updated question');
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.owner_id]);
  assert.equal((await suggest(a.owner_token)).statusCode, 404);
  assert.equal(calls, 2);
  onGenerate = async () => { await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [a.channel_id, a.collaborator_id]); };
  assert.equal((await suggest(a.collaborator_token)).statusCode, 404);
});

test('requires a hosted key and fits all 50 long messages into the prompt budget', async () => {
  assert.equal(replySuggestionProvider({}), undefined);
  onGenerate = async () => {};
  const generate = replySuggestionProvider({ GROQ_API_KEY: 'test-groq-key' })!;
  const messages = Array.from({ length: 50 }, (_, index) => ({
    speaker: 'Member ' + index, text: index + '💬'.repeat(500),
  }));
  assert.ok(await generate(messages, new AbortController().signal));
  assert.equal(context.length, 50);
  context.forEach((item, index) => assert.ok(item.text.startsWith(String(index))));
});
