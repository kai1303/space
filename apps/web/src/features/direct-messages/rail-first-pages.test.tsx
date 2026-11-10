import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAgentSessionList } from '../agents/useAgentSessionList.js';
import { useDirectMessageList } from './DirectMessages.js';

const cached = vi.hoisted(() => ({
  peek: (path: string) => path.startsWith('/workspaces/one/') ? { items: [{ id: path.includes('unread=true') ? 'unread' : 'recent' }], next_cursor: null } : undefined,
}));
vi.mock('../../shared/realtime/workspace-query-cache.js', () => ({
  useWorkspaceQueryCache: () => cached,
  readWorkspaceQuery: vi.fn(),
}));
// Keep the first network read pending to observe what the first render exposes.
vi.mock('../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: () => () => {} }));
afterEach(cleanup);

it('renders the matching warm DM page immediately and keeps searches and pagination independent', () => {
  const {result, rerender} = renderHook(({workspace, search, cursor, unread}) => useDirectMessageList(workspace, search, cursor, unread),
    {initialProps:{workspace:'one', search:'', cursor:'', unread:false}});
  expect(result.current.loaded).toBe(true);
  expect(result.current.items[0]?.id).toBe('recent');
  rerender({workspace:'one', search:'', cursor:'', unread:true});
  expect(result.current.items[0]?.id).toBe('unread');
  rerender({workspace:'one', search:'filter', cursor:'', unread:false});
  expect(result.current.loaded).toBe(false);
  rerender({workspace:'one', search:'', cursor:'older', unread:false});
  expect(result.current.items).toEqual([]);
  rerender({workspace:'two', search:'', cursor:'', unread:false});
  expect(result.current.items).toEqual([]);
});

it('renders warm recent agent sessions immediately and hides them on workspace switch', () => {
  const {result, rerender} = renderHook(({workspace}) => useAgentSessionList(workspace), {initialProps:{workspace:'one'}});
  expect(result.current.loading).toBe(false);
  expect(result.current.items[0]?.id).toBe('recent');
  rerender({workspace:'two'});
  expect(result.current.items).toEqual([]);
  expect(result.current.loading).toBe(true);
});
