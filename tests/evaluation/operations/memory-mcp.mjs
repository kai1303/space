import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

async function memoryMcp(ctx, token, scope, work) {
  const client = new Client({name: 'space-performance', version: '1'});
  const url = new URL('/mcp/memory', ctx.address);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {headers: {authorization: 'Bearer ' + token}},
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, url.href);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
      const response = await fetch(request, {signal});
      if (response.ok) ctx.recordRoute(request.method, url.pathname);
      return response;
    },
  });
  const measure = (operation, fn) => ctx.measure('Memory MCP', operation, fn);
  try {
    await measure('Connect ' + scope, () => client.connect(transport));
    const listed = await measure('List ' + scope + ' tools', () => client.listTools());
    const names = new Set(listed.tools.map(tool => tool.name));
    await work((name, args = {}) => measure(name, async () => {
      assert.ok(names.has(name), name);
      const result = await client.callTool({name, arguments: args});
      assert.notEqual(result.isError, true, name + ' ' + result.content[0]?.text);
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    }));
  } finally { await client.close(); }
}

export async function memoryTools(ctx, {writer, reader, threadReader, messageId, threadId, session}) {
  await memoryMcp(ctx, writer.token, 'channel', async call => {
    const current = await call('memory_read');
    await call('memory_write', {revision: current.revision, content: current.content + '\nChecked during benchmark.'});
    await call('memory_search', {query: 'checklist'});
    await call('memory_context');
    const claim = randomUUID();
    await call('memory_remember', {id: claim, kind: 'fact', title: 'Checklist', content: 'Review checklist', message_ids: [messageId]});
    await call('memory_forget', {source_id: 'knowledge:' + claim});
    const note = await call('knowledge_add', {id: randomUUID(), kind: 'procedure', title: 'Review checklist', content: 'Review with the team', message_ids: [messageId]});
    await call('knowledge_list');
    const updated = await call('knowledge_update', {id: note.id, revision: note.revision, content: 'Confirm the team review'});
    await call('knowledge_remove', {id: note.id, revision: updated.revision});
  });
  await memoryMcp(ctx, reader.token, 'installation', async call => {
    await call('channel_memory');
    await call('thread_memory', {thread_id: threadId});
    await call('session_memory', {session_id: session});
  });
  await memoryMcp(ctx, threadReader.token, 'thread', async call => {
    await call('thread_context');
    await call('thread_messages');
    assert.equal((await call('thread_message', {message_id: messageId})).id, messageId);
  });
}
