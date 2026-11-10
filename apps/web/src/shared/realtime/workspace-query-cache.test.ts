import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from '../api/request.js';
import { workspaceReadVersion } from './live-updates.js';
import { WorkspaceQueryCache } from './workspace-query-cache.js';

vi.mock('../api/request.js', () => ({ request: vi.fn() }));
vi.mock('./live-updates.js', () => ({ workspaceReadVersion: vi.fn() }));
const get = vi.mocked(request), version = vi.mocked(workspaceReadVersion);
const path = '/workspaces/team/notifications';
let cache: WorkspaceQueryCache;
beforeEach(() => { vi.resetAllMocks(); version.mockReturnValue({}); cache = new WorkspaceQueryCache('team'); });
afterEach(() => vi.useRealTimers());

it('shares an active read while letting each reader leave independently', async () => {
  let finish!: (value: unknown) => void;
  get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const a = new AbortController(), b = new AbortController();
  const first = cache.read(path, a.signal), second = cache.read(path + '?', b.signal);
  a.abort();
  await expect(first).rejects.toMatchObject({name:'AbortError'});
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]?.[4]?.aborted).toBe(false);
  finish({items:[1]});
  expect(await second).toEqual({items:[1]});
  expect(cache.peek(path)).toEqual({items:[1]});
  expect(await cache.read(path)).toEqual({items:[1]});
  expect(get).toHaveBeenCalledTimes(1);
});

it('abandons an unobserved read without letting its late response replace a new read', async () => {
  let finish!: (value: unknown) => void;
  get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce('new');
  const a = new AbortController();
  const old = cache.read(path, a.signal);
  a.abort();
  expect(get.mock.calls[0]?.[4]?.aborted).toBe(true);
  await expect(old).rejects.toMatchObject({name:'AbortError'});
  expect(await cache.read(path)).toBe('new');
  finish('old'); await Promise.resolve(); await Promise.resolve();
  expect(cache.peek(path)).toBe('new');
});

it('never reuses closed, invalidated, expired, or other viewer pages', async () => {
  get.mockResolvedValue('page');
  vi.useFakeTimers();
  await cache.read(path); await cache.read(path + '?unread=true');
  expect(new WorkspaceQueryCache('team').peek(path)).toBeUndefined();
  cache.invalidate(path);
  expect(cache.peek(path + '?unread=true')).toBeUndefined();
  await cache.read(path);
  vi.advanceTimersByTime(30_001);
  expect(cache.peek(path)).toBeUndefined();
  await cache.read(path);
  version.mockReturnValue({});
  expect(cache.peek(path)).toBeUndefined();
  version.mockReturnValue(undefined);
  await cache.read(path); await cache.read(path);
  expect(cache.peek(path)).toBeUndefined();
  expect(get).toHaveBeenCalledTimes(6);
});

it('retries errors and bounds the retained pages', async () => {
  get.mockRejectedValueOnce(new Error('network')).mockResolvedValue('ok');
  await expect(cache.read(path)).rejects.toThrow('network');
  await cache.read(path);
  for (let i = 0; i < 16; i++) await cache.read(path + '?page=' + i);
  expect(cache.peek(path)).toBeUndefined();
  expect(cache.peek(path + '?page=15')).toBe('ok');
});
