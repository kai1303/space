import { expect, it } from 'vitest';
import { conversationPath, parseConversationPath } from './conversation-link.js';

const channel = '550e8400-e29b-41d4-a716-446655440000';
const thread = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
it('round-trips UUIDs as compact URL-safe conversation and thread paths', () => {
  expect(conversationPath(channel)).toBe('/c/VQ6EAOKbQdSnFkRmVUQAAA');
  const path = conversationPath(channel, thread)!;
  expect(path).toMatch(/^\/c\/[\w-]{22}\/thread\/[\w-]{22}$/);
  expect(parseConversationPath(path)).toEqual({ channel, thread });
});
it('rejects malformed paths and noncanonical trailing bits', () => {
  for (const path of ['/c/xyz', '/c/VQ6EAOKbQdSnFkRmVUQAAB', '/c/VQ6EAOKbQdSnFkRmVUQAAA/thread/', '/c/VQ6EAOKbQdSnFkRmVUQAAA/other']) {
    expect(() => parseConversationPath(path)).toThrow();
  }
});
