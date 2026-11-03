import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import type { Task, WorkplaceEvent } from '@space/contracts';
const values = Object.fromEntries((await readFile(process.env.DEMO_ENV_FILE ?? '.env.demo', 'utf8')).trim().split('\n').map(line => line.split('=')));
const base = process.env.API_URL ?? 'http://127.0.0.1:3000';
async function api<T>(path: string, method = 'GET', body?: unknown, collaborator = false): Promise<T> {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${collaborator ? values.COLLABORATOR_TOKEN : values.OWNER_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`API ${response.status}: ${JSON.stringify(data)}`);
  return data as T;
}
const task = await api<Task>('/v1/tasks', 'POST', { workspace_id: values.WORKSPACE_ID, thread_id: values.THREAD_ID, installation_id: values.INSTALLATION_ID, goal: 'Review paid-customer churn before Friday', skill: 'demo.echo' }, true);
assert.equal(task.status, 'awaiting_approval');
console.log(`Task ${task.id}: proposed by collaborator, awaiting owner approval`);
await api(`/v1/tasks/${task.id}/approve`, 'POST', {});
let cursor = 0;
const deadline = Date.now() + 15_000;
let completed = false;
while (Date.now() < deadline) {
  const events = await api<WorkplaceEvent[]>(`/v1/tasks/${task.id}/events?after=${cursor}`);
  for (const event of events) { console.log(`${event.sequence}. ${event.type}`); cursor = event.sequence; }
  const current = await api<Task>(`/v1/tasks/${task.id}`);
  if (current.status === 'completed') {
    const messages = await api<{ task_id: string; text: string }[]>(`/v1/threads/${values.THREAD_ID}/messages`);
    assert.equal(messages.filter(message => message.task_id === task.id).length, 1);
    console.log(current.result);
    console.log('Verified: one result reply in the originating thread.');
    completed = true; break;
  }
  if (current.status === 'failed') throw new Error('Task failed; inspect task events');
  await setTimeout(100);
}
if (!completed) throw new Error('Demo timed out; ensure the worker is running');
