import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryTools } from './memory-mcp.mjs';

export async function workspaceTools({ owner, call, ws, channel, thread }) {
  const workspace = '/workspaces/' + ws, room = '/channels/' + channel;
  await owner.call('Service', 'Health', 'GET', '/healthz');
  await owner.call('Service', 'Readiness', 'GET', '/readyz');
  const agents = call('Agent Sessions');
  for (const [label, path] of [
    ['Available connectors', '/agents/connectors'],
    ['Workspace installations', '/agents/installations?workspace_id=' + ws],
    ['Channel agents', room + '/agents'],
    ['Channel local agents', room + '/local-agents'],
    ['Channel local Codex agents', room + '/local-codex'],
    ['Workspace sessions', workspace + '/agent-sessions'],
    ['Discover sessions', workspace + '/agent-sessions/discover'],
    ['Sidekick agents', workspace + '/sidekick-agents'],
    ['Sidekick sessions', workspace + '/sidekick-sessions'],
    ['Thread sessions', thread + '/agent-sessions'],
  ]) await agents(label, 'GET', path);

  const navigator = call('Navigator');
  await navigator('Channel settings', 'GET', room + '/navigator');
  await navigator('Set execution mode', 'PATCH', room + '/navigator', {execution_mode: 'suggest'});
  await navigator('Channel observations', 'GET', room + '/navigator/observations');
  await navigator('Channel suggestions', 'GET', room + '/navigator/suggestions');
  await navigator('Thread subscription', 'GET', thread + '/agent-subscription');

  const todo = call('Todo sync');
  const id = randomUUID(), sources = workspace + '/hub/todo-sources', source = sources + '/' + id;
  await todo('Create source', 'POST', source, {name: 'Benchmark issue tracker'}, 201);
  await todo('List sources', 'GET', sources);
  const {token} = await todo('Rotate source token', 'POST', source + '/token', {});
  const items = '/todo-sync/' + id + '/items', headers = {authorization: 'Bearer ' + token};
  const item = {external_id: 'ISSUE-1', revision: '1', title: 'Benchmark issue', completed: false};
  const result = await todo('Import item', 'POST', items, item, 200, headers);
  assert.equal(result.result, 'applied');
  const receipts = await todo('List receipts', 'GET', items, undefined, 200, headers);
  assert.ok(receipts.items.some(receipt => receipt.id === result.id));
  await todo('Revoke source', 'POST', source + '/revoke', {});
}

export async function channelMemory(ctx, {call, channel, thread, installation, messageId, session}) {
  const memory = call('Memory'), room = '/channels/' + channel, path = room + '/memory';
  const {document} = await memory('Enable channel memory', 'POST', path + '/settings', {enabled: true});
  await memory('Enable channel knowledge', 'POST', path + '/knowledge', {enabled: true});
  const content = 'Release checklist for the benchmark';
  const edited = await memory('Edit document', 'POST', path + '/document', {revision: document.revision, content});
  assert.equal(edited.content, content);
  const id = randomUUID();
  await memory('Import document source', 'POST', path + '/sources', {source_id: id, name: 'notes.md', content: 'Review the checklist'});
  const hits = await memory('Search channel memory', 'GET', path + '/search?q=checklist');
  assert.ok(hits.items.length > 0);
  await memory('Read channel memory', 'GET', path);
  await memory('Read channel layers', 'GET', path + '/layers');
  await memory('Read thread memory', 'GET', room + thread + '/memory');
  await memory('Read thread context', 'GET', room + thread + '/context');
  await memory('Set agent access', 'POST', path + '/agents/' + installation, {access: 'read'});
  await memory('List memory agents', 'GET', path + '/agents');
  const request = {name: 'Benchmark reader', access: 'read'};
  const channelReader = await memory('Create channel connection', 'POST', path + '/connections', request, 201);
  const threadReader = await memory('Create thread connection', 'POST', room + thread + '/context/connections', request, 201);
  const reader = await memory('Create installation connection', 'POST', path + '/connections', {...request, installation_id: installation}, 201);
  const writer = await memory('Create writer connection', 'POST', path + '/connections', {name: 'Benchmark writer', access: 'write'}, 201);
  await memoryTools(ctx, {reader, writer, threadReader, messageId, threadId: thread.split('/').at(-1), session});
  const {items} = await memory('List channel connections', 'GET', path + '/connections');
  for (const {connection} of [channelReader, threadReader, reader, writer]) {
    assert.ok(items.some(item => item.id === connection.id));
    await memory('Revoke connection', 'POST', path + '/connections/' + connection.id + '/revoke', {});
  }
  await memory('Remove document source', 'DELETE', path + '/sources/document:' + id);
  assert.equal((await memory('Clear memory', 'DELETE', path)).deleted, true);
}

export async function agentLifecycle({call, ws, channel, thread, dm, peer, peerId, messageId, installation, pairing}) {
  const agents = call('Agent Sessions');
  const room = '/channels/' + channel, connection = '/agents/connections/' + installation;
  assert.equal((await agents('Pairing status', 'GET', '/agent-pairings/' + pairing)).status, 'claimed');
  const pending = await agents('Start pairing to cancel', 'POST', '/workspaces/' + ws + '/agent-pairings', {}, 201);
  assert.equal((await agents('Cancel pairing', 'POST', '/agent-pairings/' + pending.id + '/cancel', {})).status, 'cancelled');
  const {granted_skills} = await agents('Enable channel agent', 'POST', connection + room, {enabled: true});
  assert.ok(granted_skills.includes('codex.run'));
  const create = () => ({installation_id: installation, client_session_id: randomUUID(), title: 'Benchmark session', skill: 'codex.run'});
  const tasks = call('Tasks'), idempotency = () => ({'idempotency-key': randomUUID()});
  const input = {workspace_id: ws, thread_id: thread.split('/').at(-1), installation_id: installation, skill: 'codex.run', goal: 'Review checklist'};
  const task = await tasks('Propose task', 'POST', '/tasks', input, 201, idempotency());
  const taskPath = '/tasks/' + task.id;
  assert.equal((await tasks('Read task', 'GET', taskPath)).status, 'awaiting_approval');
  await tasks('Task events', 'GET', taskPath + '/events');
  await tasks('Reject task', 'POST', taskPath + '/reject', {});
  await agents('Create Sidekick session', 'POST', '/workspaces/' + ws + '/sidekick-sessions',
    {client_session_id: randomUUID(), installation_id: installation, skill: 'codex.run', source: {channel_id: channel, message_ids: [messageId]}}, 201);
  const session = await agents('Create thread session', 'POST', thread + '/agent-sessions', create(), 201);
  const path = '/agent-sessions/' + session.id;
  await agents('Create channel session', 'POST', room + '/agent-sessions', {...create(), client_thread_id: randomUUID()}, 201);
  await agents('Read session', 'GET', path);
  await agents('Locate session', 'GET', path + '/location');
  await agents('Session resources', 'GET', path + '/resources');
  await agents('Available models', 'GET', path + '/models');
  await agents('Session team', 'GET', path + '/team');
  await agents('Session reports', 'POST', room + '/session-reports', {threads: [thread.split('/').at(-1)]});
  await agents('Set team visibility', 'PUT', path + '/team/visibility', {workspace_visible: true});
  const reviewer = path + '/team/reviewers/' + peerId;
  await agents('Add reviewer', 'PUT', reviewer, {});
  await call('Agent Sessions', peer)('Post team discussion', 'POST', path + '/team/discussion', {text: 'Reviewed'}, 200, {'idempotency-key': randomUUID()});
  await agents('Remove reviewer', 'DELETE', reviewer);
  await agents('Rename session', 'PATCH', path, {title: 'Review session', previous_title: session.title});
  await agents('Archive sidebar entry', 'PATCH', path + '/sidebar', {archived: true});
  await call('Memory')('Read session memory', 'GET', room + path + '/memory');
  await agents('End session', 'POST', path + '/end', {});
  await agents('Reopen session', 'POST', path + '/reopen', {});
  await agents('List vault Macs', 'GET', '/me/vault/macs');
  await call('Calls')('DM call history', 'GET', '/channels/' + dm + '/calls');
  await agents('Revoke connection', 'POST', connection + '/revoke', {});
}
