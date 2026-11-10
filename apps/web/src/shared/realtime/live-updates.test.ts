import { afterEach, expect, it, vi } from 'vitest';
import { invalidateUpdates, subscribeUpdates, workspaceReadVersion } from './live-updates.js';
const stops = new Set<() => void>();
function watch(...args: Parameters<typeof subscribeUpdates>) { const stop=subscribeUpdates(...args); stops.add(stop); return stop; }
const clients = vi.hoisted(() => [] as any[]);
vi.mock('socket.io-client', () => ({ io: () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const client = {
    connected: false, off: (name: string, fn: (...args: any[]) => void) => { if (handlers.get(name) === fn) handlers.delete(name); },
    on: (name: string, fn: (...args: any[]) => void) => { handlers.set(name, fn); return client; },
    connect: vi.fn(() => { client.connected = true; handlers.get('connect')?.(); }),
    disconnect: vi.fn(() => { client.connected = false; }),
    rpc: vi.fn(async () => ({ data: {} })),
    timeout: () => ({ emitWithAck: client.rpc }),
    receive: (name: string, ...args: any[]) => handlers.get(name)?.(...args),
  };
  clients.push(client); return client;
} }));
afterEach(() => { for (const stop of stops) stop(); stops.clear(); clients.length = 0; vi.useRealTimers(); });
it('refreshes only active listeners in the changed scope after a local write', async () => {
  const a = vi.fn(), b = vi.fn(), other = vi.fn(), channel = vi.fn();
  const stop = watch('workspace', 'team', a);
  watch('workspace', 'team', b);
  watch('workspace', 'other', other);
  watch('channel', 'team', channel);
  await vi.waitFor(() => expect(channel).toHaveBeenCalledTimes(2));
  a.mockClear(); b.mockClear(); other.mockClear(); channel.mockClear();
  await invalidateUpdates('workspace', 'team');
  expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled(); expect(channel).not.toHaveBeenCalled();
  stop(); a.mockClear(); b.mockClear();
  await invalidateUpdates('workspace', 'team');
  expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledOnce();
});
it('shares one connection per authorized scope and closes it after the last listener', async () => {
  const a = vi.fn(), b = vi.fn();
  const stopA = watch('workspace', 'a', a), stopB = watch('workspace', 'a', b);
  await vi.waitFor(() => expect(b).toHaveBeenCalled());
  expect(clients).toHaveLength(1);
  const before = a.mock.calls.length;
  clients[0].receive('updates.changed', { scope: 'workspace', id: 'b' });
  await Promise.resolve();
  expect(a).toHaveBeenCalledTimes(before);
  clients[0].receive('updates.changed', { scope: 'workspace', id: 'a' });
  await vi.waitFor(() => expect(a.mock.calls.length).toBeGreaterThan(before));
  stopA(); expect(clients[0].disconnect).not.toHaveBeenCalled();
  stopB(); expect(clients[0].disconnect).toHaveBeenCalledTimes(1);
});
it('queues one refresh when changes arrive during an in-flight read', async () => {
  let release!: () => void;
  const read = vi.fn();
  const stop = watch('task', 'a', read);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  read.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  clients[0].receive('updates.changed', { scope: 'task', id: 'a' });
  clients[0].receive('updates.changed', { scope: 'task', id: 'a' });
  clients[0].receive('updates.changed', { scope: 'task', id: 'a' });
  expect(read).toHaveBeenCalledTimes(3);
  release();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  stop();
});
it('waits for the queued read before completing local invalidation', async () => {
  const read = vi.fn();
  watch('workspace', 'team', read);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  let release!: () => void;
  read.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  clients[0].receive('updates.changed', { scope: 'workspace', id: 'team' });
  const complete = vi.fn();
  const invalidation = invalidateUpdates('workspace', 'team').then(complete);
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  release(); await invalidation;
  expect(read).toHaveBeenCalledTimes(4);
  expect(complete).toHaveBeenCalledOnce();
});
it('refreshes on reconnect and revocation without a recurring API timer', async () => {
  const refresh = vi.fn();
  const stop = watch('channel', 'a', refresh);
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  clients[0].receive('updates.revoked', { scope: 'channel', id: 'a', error: 'not_found' });
  await Promise.resolve(); await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(3);
  stop();
});

it('clears revoked resources immediately even while a read is pending', async () => {
 let release!: () => void;
 const read = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
 const revoke = vi.fn();
 const stop = watch('task', 'private', read, revoke);
 clients[0].receive('updates.revoked', { scope: 'task', id: 'private', error: 'not_found' });
 expect(revoke).toHaveBeenCalledWith('not_found');
 release(); await Promise.resolve(); await Promise.resolve();
 expect(read).toHaveBeenCalledTimes(1);
 stop();
});

it('retries a transient namespace rejection with backoff', async () => {
 const stop = watch('workspace', 'retry', vi.fn());
 await vi.waitFor(() => expect(clients[0].connect).toHaveBeenCalledTimes(1));
 vi.useFakeTimers();
 clients[0].connected = false;
 clients[0].receive('connect_error', new Error('internal_error'));
 await vi.advanceTimersByTimeAsync(1501);
 expect(clients[0].connect).toHaveBeenCalledTimes(2);
 stop();
});

it('shares a single transport across different resource scopes', async () => {
 const stopWorkspace=watch('workspace','team',vi.fn());
 const stopChannel=watch('channel','general',vi.fn());
 await Promise.resolve();
 expect(clients).toHaveLength(1);
 stopChannel(); expect(clients[0].disconnect).not.toHaveBeenCalled();
 stopWorkspace(); expect(clients[0].disconnect).toHaveBeenCalledTimes(1);
});

it('revokes only the affected resource while other subscriptions keep receiving events', async () => {
 const channelChanged=vi.fn(), revoked=vi.fn(), workspaceRevoked=vi.fn();
 const stopWorkspace=watch('workspace','team',vi.fn(),workspaceRevoked);
 const stopChannel=watch('channel','private',channelChanged,revoked);
 await vi.waitFor(()=>expect(channelChanged).toHaveBeenCalled());
 clients[0].receive('updates.revoked',{scope:'channel',id:'private',error:'not_found'});
 expect(revoked).toHaveBeenCalledWith('not_found');
 expect(workspaceRevoked).not.toHaveBeenCalled();
 expect(clients[0].connected).toBe(true);
 stopChannel(); stopWorkspace();
});

it('does not unsubscribe a replacement when a revoked watcher later unmounts', async () => {
 const owner=watch('workspace','team',vi.fn());
 const old=watch('channel','same',vi.fn(),vi.fn());
 await vi.waitFor(()=>expect(clients[0].rpc.mock.calls.filter(([name]: any[])=>name==='updates.subscribe')).toHaveLength(2));
 clients[0].receive('updates.revoked',{scope:'channel',id:'same',error:'not_found'});
 const replacement=watch('channel','same',vi.fn());
 await vi.waitFor(()=>expect(clients[0].rpc.mock.calls.filter(([name]: any[])=>name==='updates.subscribe')).toHaveLength(3));
 const before=clients[0].rpc.mock.calls.filter(([name]: any[])=>name==='updates.unsubscribe').length;
 old(); await Promise.resolve(); await Promise.resolve();
 expect(clients[0].rpc.mock.calls.filter(([name]: any[])=>name==='updates.unsubscribe')).toHaveLength(before);
 replacement(); owner();
});

it('ignores an old subscribe failure after the shared connection has reconnected', async () => {
 const owner=watch('workspace','team',vi.fn());
 await vi.waitFor(()=>expect(clients[0].rpc).toHaveBeenCalled());
 let reject!: (error: Error) => void;
 clients[0].rpc.mockImplementationOnce(()=>new Promise((_resolve: unknown, fail: (error: Error)=>void)=>{reject=fail;}));
 const stop=watch('channel','reconnect',vi.fn());
 await vi.waitFor(()=>expect(reject).toBeTypeOf('function'));
 clients[0].connected=false; clients[0].receive('disconnect','transport close');
 clients[0].connect();
 reject(new Error('old request failed'));
 await vi.waitFor(()=>expect(clients[0].rpc.mock.calls.length).toBeGreaterThan(2));
 expect(clients[0].disconnect).not.toHaveBeenCalled();
 stop(); owner();
});

it('surfaces a subscription limit without reconnecting other authorized streams', async () => {
 const owner=watch('workspace','team',vi.fn());
 await vi.waitFor(()=>expect(clients[0].rpc).toHaveBeenCalled());
 clients[0].rpc.mockResolvedValueOnce({error:'subscription_limit'});
 const denied=vi.fn(),stop=watch('task','over-limit',vi.fn(),denied);
 await vi.waitFor(()=>expect(denied).toHaveBeenCalledWith('subscription_limit'));
 expect(clients[0].connected).toBe(true);expect(clients[0].disconnect).not.toHaveBeenCalled();
 stop();owner();
});

it('allows page reuse only inside an uninterrupted acknowledged workspace subscription', async () => {
  const stop = watch('workspace', 'team', () => {}, () => {});
  expect(workspaceReadVersion('team')).toBeUndefined();
  await vi.waitFor(() => expect(workspaceReadVersion('team')).toBeDefined());
  let previous = workspaceReadVersion('team');
  clients[0].receive('updates.changed', { scope: 'workspace', id: 'elsewhere' });
  expect(workspaceReadVersion('team')).toBe(previous);
  for (const change of [
    () => clients[0].receive('updates.changed', { scope: 'workspace', id: 'team' }),
    () => invalidateUpdates('workspace', 'team'),
    () => window.dispatchEvent(new Event('focus')),
  ]) {
    await change();
    const current = workspaceReadVersion('team');
    expect(current).toBeDefined(); expect(current).not.toBe(previous); previous = current;
  }
  clients[0].receive('disconnect');
  expect(workspaceReadVersion('team')).toBeUndefined();
  clients[0].receive('connect');
  await vi.waitFor(() => expect(workspaceReadVersion('team')).toBeDefined());
  expect(workspaceReadVersion('team')).not.toBe(previous);
  clients[0].receive('updates.revoked', { scope: 'workspace', id: 'team', error: 'forbidden' });
  expect(workspaceReadVersion('team')).toBeUndefined();
  stop();
});
