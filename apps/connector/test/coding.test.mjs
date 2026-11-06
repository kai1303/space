import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseOptions } from '../dist/main.js';
import { AgentProgress } from '../dist/agent-progress.js';
import { localSessionStore } from '../dist/session-storage.js';
import { sessionRuntime } from '../dist/session-runtime.js';
import { turnScopedRuntime } from '../dist/outbound-tools.js';

test('coding is explicit and requires an absolute project', () => {
  assert.throws(() => parseOptions(['--coding']), /project/);
  assert.throws(() => parseOptions(['--coding', '--project', 'relative']), /absolute/);
  assert.throws(() => parseOptions(['--coding', '--project', '/tmp', '--logout']));
  assert.equal(parseOptions(['--coding', '--project', '/tmp']).coding, true);
  assert.equal(parseOptions(['--project', '/tmp']).coding, undefined);
});

test('coding storage cannot resume chat mappings or a different project', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'space-coding-store-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const project = join(directory, 'project'); await mkdir(project);
  const storage = { directory, project, connection:{origin:'http://localhost',workspace_id:'w',installation_id:'i',credential:'c'},identity:{issuer:'i',subject:'s',client_id:'c'} };
  const chat = await localSessionStore(storage), coding = await localSessionStore({...storage,coding:true});
  assert.notEqual(chat.directory, coding.directory);
  const id = randomUUID(); await (await chat.session(id,false)).save('native-thread',true);
  await assert.rejects(coding.session(id,true));
});

test('coding tool bursts retain the most recent bounded timeline', () => {
  const output = new AgentProgress(true);
  for (let i=0;i<120;i++) output.tool(String(i), 'shell', {command:'echo test'}, 'completed', String(i));
  const snapshot = output.snapshot([]);
  assert.equal(snapshot.tools.length, 30);
  assert.equal(snapshot.tools[0].id, '90'); assert.equal(snapshot.tools.at(-1).id, '119');
  assert.equal(snapshot.items.length, 30); assert.ok(JSON.stringify(snapshot).length <= 64000);
});

test('runtime wrappers preserve the approval controller', async () => {
  const execution_id=randomUUID(), request={schema_version:'1.0',task_id:randomUUID(),execution_id,idempotency_key:execution_id,session_id:randomUUID(),skill:'codex.run',goal:'test'};
  const controls={requestApproval:async()=> 'deny'}; let received;
  const inner=()=>Promise.resolve({alive:()=>true,stop(){},async invoke(_r,_e,_s,c){received=c;}});
  for (const factory of [() => sessionRuntime(inner), () => turnScopedRuntime(inner,()=>{})]) {
    const runtime=await factory(); await runtime.invoke(request,async()=>{},new AbortController().signal,controls);
    assert.equal(received,controls); runtime.stop();
  }
});


test('coding changes and tool output share a bounded escaped response budget', () => {
  const output = new AgentProgress(true);
  for(let i=0;i<30;i++) {
    output.change(`path-${i}`, '\n'.repeat(32000));
    output.tool(String(i),'shell','\\'.repeat(8000),'completed','\n'.repeat(16000));
  }
  const snapshot=output.snapshot([]);
  assert.equal(snapshot.outputs.changes.length,20);
  assert.ok(JSON.stringify(snapshot).length<=64000);
  assert.ok(snapshot.outputs.changes.every(change=>change.patch.length<=32000));
  assert.match(snapshot.outputs.changes.at(-1).patch,/truncated/);
});
