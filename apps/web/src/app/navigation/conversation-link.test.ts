import { expect, it } from 'vitest';
import { conversationPath, parseConversationPath, workspacePath, workspaceIdFromPath, messagePath, sessionPath, parseSessionPath } from '@space/contracts';

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

it('round-trips workspace, session and message links without confusing a workspace slug for an ID', () => {
  const workspace = 'b232851a-61d8-44f5-a514-c7b0405694c2';
  expect(workspacePath(workspace)).toBe('/w/sjKFGmHYRPWlFMewQFaUwg');
  expect(workspaceIdFromPath(workspacePath(workspace) + '/activity')).toBe(workspace);
  expect(workspaceIdFromPath('/w/my-team')).toBeUndefined();
  const slug = 'a'.repeat(21) + 'g';
  expect(workspaceIdFromPath('/w/' + slug)).toBeUndefined();
  const collision = workspaceIdFromPath('/w/~' + slug)!;
  expect(workspacePath(collision)).toBe('/w/~' + slug);
  expect(parseSessionPath(sessionPath(thread)!)).toBe(thread);
  expect(() => parseSessionPath('/s/not-a-key')).toThrow();
  expect(parseConversationPath(messagePath(channel,thread))).toEqual({channel, message:thread});
});
