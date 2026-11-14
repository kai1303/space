import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AgUiConnector } from '@space/core/ag-ui';
import { parseAgentEvent, type AgentEvent, type InvocationRequest } from '@space/contracts';

const invocation = (): InvocationRequest => {
  const execution_id = randomUUID();
  return { schema_version: '1.0', task_id: randomUUID(), execution_id, session_id: randomUUID(), idempotency_key: execution_id, goal: 'Review results', skill: 'ag-ui.run' };
};
async function backend(events: (request: any) => object[], run: (url: string) => Promise<void>) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(req.headers['idempotency-key'], input.runId);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events(input)) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const started = (request: any) => ({ type: 'RUN_STARTED', threadId: request.threadId, runId: request.runId });
const finished = (request: any) => ({ type: 'RUN_FINISHED', threadId: request.threadId, runId: request.runId });

test('HTTP AG-UI streams text, tool activity and structured results through replayable Space envelopes', async () => {
  const request = invocation();
  const warning = { id: 'dependency', type: 'alert', level: 'warning', title: 'Dependency conflict' };
  const error = { ...warning, level: 'error', body: 'Build failed.' };
  const edit = { id: 'proposal', type: 'document_edit', title: 'Notes.odt', original: 'Before', replacement: 'After' };
  await backend(input => [started(input),
    { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Hello **' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Kai**' },
    { type: 'TEXT_MESSAGE_END', messageId: 'm' },
    { type: 'CUSTOM', name: 'space.ui', value: warning },
    { type: 'TOOL_CALL_START', toolCallId: 't', toolCallName: 'search' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '{"query":' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '"churn"}' },
    { type: 'TOOL_CALL_END', toolCallId: 't' },
    { type: 'TOOL_CALL_RESULT', toolCallId: 't', messageId: 'result', content: 'Found 3 records' },
    { type: 'CUSTOM', name: 'space.ui', value: { id: 'card', type: 'card', title: 'Churn', body: 'Down 2%' } },
    { type: 'CUSTOM', name: 'space.ui', value: { id: 'table', type: 'table', title: 'Customers', columns: ['Plan'], rows: [['Pro']] } },
    { type: 'CUSTOM', name: 'space.ui', value: edit },
    { type: 'CUSTOM', name: 'space.ui', value: error },
    finished(input),
  ], async url => {
    const invoke = async () => {
      const events: AgentEvent[] = [];
      await new AgUiConnector({ url }).invoke(request, async raw => { events.push(parseAgentEvent(raw)); }, new AbortController().signal);
      return events;
    };
    const events = await invoke();
    assert.equal(events[0]?.type, 'execution.started');
    assert.equal(events.at(-1)?.type, 'execution.completed');
    assert.equal(events.at(-1)?.payload.text, 'Hello **Kai**');
    const response = events.at(-1)!.payload.response!;
    assert.equal(response.messages[0]?.text, 'Hello **Kai**');
    assert.equal(response.tools[0]?.arguments, '{"query":"churn"}');
    assert.equal(response.tools[0]?.status, 'completed');
    assert.equal(response.components.length, 4);
    assert.deepEqual(response.components[3], edit);
    assert.deepEqual(response.components[0], error);
    assert.deepEqual(response.items?.slice(0, 3), [{ type: 'message', id: 'm' }, { type: 'component', id: warning.id }, { type: 'tool', id: 't' }]);
    assert.ok(events.some(event => event.payload.response?.components.some(block => block.type === 'alert' && block.level === 'warning')));
    assert.ok(events.some(e => e.payload.response?.tools[0]?.status === 'running'), 'argument end does not mean tool execution finished');
    assert.deepEqual(await invoke(), events, 'backend replay produces identical persisted envelopes');
  });
});

test('a truncated backend stream cannot complete an execution', async () => {
  await backend(input => [started(input)], async url => {
    await assert.rejects(new AgUiConnector({ url }).invoke(invocation(), async () => {}, new AbortController().signal));
  });
});

test('backend errors and unsupported interrupts fail visibly rather than claiming completion', async () => {
  for (const end of [
    (_input: any) => ({ type: 'RUN_ERROR', message: 'Backend unavailable' }),
    (input: any) => ({ ...finished(input), outcome: { type: 'interrupt', interrupts: [{ id: 'approval', reason: 'permission' }] } }),
  ]) await backend(input => [started(input), end(input)], async url => {
    const events: AgentEvent[] = [];
    await new AgUiConnector({ url }).invoke(invocation(), async raw => { events.push(parseAgentEvent(raw)); }, new AbortController().signal);
    assert.equal(events.at(-1)?.type, 'execution.failed');
  });
});

test('worker cancellation aborts the AG-UI request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new AgUiConnector({ url: 'http://127.0.0.1:1' }).invoke(invocation(), async () => { assert.fail('must not emit'); }, controller.signal));
});

test('cancellation closes an in-flight SSE response', async () => {
  const controller = new AbortController();
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.on('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(started(JSON.parse(body)))}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(new AgUiConnector({ url: `http://127.0.0.1:${address.port}` }).invoke(invocation(), async () => { controller.abort(); }, controller.signal));
    await Promise.race([disconnected, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('SSE response stayed open')), 1000); timer.unref(); })]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('invalid UI payloads cannot turn a backend stream into a completed response', async () => {
  await backend(input => [started(input), { type: 'CUSTOM', name: 'space.ui', value: { id: 'x', type: 'html', html: '<script>run()</script>' } }, finished(input)], async url => {
    const events: AgentEvent[] = [];
    await assert.rejects(new AgUiConnector({ url }).invoke(invocation(), async raw => { events.push(parseAgentEvent(raw)); }, new AbortController().signal));
    assert.equal(events.some(event => event.type === 'execution.completed'), false);
  });
});
