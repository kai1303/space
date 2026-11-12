import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '@space/contracts';

test('outbound connections accept only explicit HTTPS bearer or anonymous configuration', () => {
  const parse = (contracts as any).parseOutboundConnection;
  assert.equal(typeof parse, 'function', 'outbound configuration parser exists');
  assert.deepEqual(parse({ name: 'Work', url: 'https://mcp.example.com/mcp', auth_type: 'bearer', token: 'secret' }), {
    name: 'Work',
    kind: 'mcp',
    url: 'https://mcp.example.com/mcp',
    auth_type: 'bearer',
    token: 'secret',
  });
  for (const url of [
    'http://mcp.example.com',
    'https://user:secret@example.com',
    'https://example.com/#fragment',
    'file:///tmp/x',
    'https://example.com/?token=secret',
  ])
    assert.throws(() => parse({ name: 'Bad', url, auth_type: 'none' }));
  assert.throws(() => parse({ name: 'Bad', url: 'https://example.com', auth_type: 'bearer' }));
  assert.throws(() => parse({ name: 'Bad', url: 'https://example.com', auth_type: 'none', token: 'secret' }));
  assert.throws(() => parse({ name: 'Bad', url: 'https://example.com', auth_type: 'oauth' }));
});
test('catalogs are bounded and require unique valid tools with object schemas', () => {
  const parse = (contracts as any).parseOutboundTools;
  assert.equal(typeof parse, 'function', 'outbound tool parser exists');
  const tool = {
    name: 'read_issue',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  };
  assert.deepEqual(parse([tool]), [tool]);
  for (const value of [
    [tool, tool],
    [{ name: 'x', inputSchema: { type: 'string' } }],
    Array.from({ length: 101 }, (_, i) => ({ ...tool, name: `tool${i}` })),
    [{ ...tool, name: 'x'.repeat(65) }],
  ])
    assert.throws(() => parse(value));
});
