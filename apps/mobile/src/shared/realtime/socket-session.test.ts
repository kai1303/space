import { createRealtime } from './socket-session';

type Handler = (...args: any[]) => void;
class FakeSocket {
  connected = false;
  active = false;
  io = { opts: {} as { extraHeaders?: Record<string, string> } };
  connects: (Record<string, string> | undefined)[] = [];
  sent: string[] = [];
  replies: ((event: string) => Promise<unknown>)[] = [];
  private handlers = new Map<string, Set<Handler>>();
  on(event: string, handler: Handler) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event)!.add(handler); return this; }
  off(event: string, handler: Handler) { this.handlers.get(event)?.delete(handler); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  fire(event: string, ...args: unknown[]) { for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args); }
  connect() { this.connects.push(this.io.opts.extraHeaders); this.active = true; return this; }
  disconnect() { this.active = false; if (this.connected) { this.connected = false; this.fire('disconnect', 'io client disconnect'); } return this; }
  open() { this.connected = true; this.fire('connect'); }
  timeout() { return { emitWithAck: (event: string) => { this.sent.push(event); return (this.replies.shift() ?? (async () => ({ data: 'ok' })))(event); } }; }
}
function fakeAuth() {
  const listeners = { renewed: new Set<() => void>(), expired: new Set<() => void>() };
  const state = { cookie: 'a=1', refreshResult: true };
  return {
    headers: () => ({ origin: 'https://space.test', cookie: state.cookie }),
    refresh: jest.fn(async (): Promise<boolean> => {
      if (state.refreshResult) { state.cookie = 'a=2'; listeners.renewed.forEach(listener => listener()); }
      return state.refreshResult;
    }),
    expire: jest.fn(async () => { listeners.expired.forEach(listener => listener()); }),
    on: (event: 'renewed' | 'expired', listener: () => void) => { listeners[event].add(listener); return () => { listeners[event].delete(listener); }; },
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
  const socket = new FakeSocket();
  const auth = fakeAuth();
  return { socket, auth, realtime: createRealtime('https://space.test', auth, () => socket as never) };
}

it('connects with the session headers', () => {
  const { socket, realtime } = setup();
  realtime.start();
  expect(socket.connects).toEqual([{ origin: 'https://space.test', cookie: 'a=1' }]);
});

it('renews once on unauthorized and reconnects with the new cookie', async () => {
  const { socket, auth, realtime } = setup();
  realtime.start();
  socket.fire('connect_error', new Error('unauthorized'));
  await settle();
  expect(auth.refresh).toHaveBeenCalledTimes(1);
  expect(socket.connects.at(-1)).toEqual({ origin: 'https://space.test', cookie: 'a=2' });
});

it('expires the session after a second unauthorized without a connect', async () => {
  const { socket, auth, realtime } = setup();
  realtime.start();
  socket.fire('connect_error', new Error('unauthorized'));
  await settle();
  socket.fire('chat.error', { error: 'unauthorized' });
  await settle();
  expect(auth.expire).toHaveBeenCalledTimes(1);
  realtime.start();
  expect(socket.connects).toHaveLength(2);
});

it('sends commands one at a time', async () => {
  const { socket, realtime } = setup();
  realtime.start(); socket.open();
  let release!: (value: unknown) => void;
  socket.replies.push(() => new Promise(resolve => { release = resolve; }), async () => ({ data: 'second' }));
  const first = realtime.command('a', {});
  const second = realtime.command('b', {});
  await settle();
  expect(socket.sent).toEqual(['a']);
  release({ data: 'first' });
  await expect(first).resolves.toBe('first');
  await expect(second).resolves.toBe('second');
});

it('rejects commands while disconnected and surfaces server errors', async () => {
  const { socket, realtime } = setup();
  await expect(realtime.command('a', {})).rejects.toThrow('Reconnecting');
  realtime.start(); socket.open();
  socket.replies.push(async () => ({ error: 'forbidden' }));
  await expect(realtime.command('a', {})).rejects.toThrow('forbidden');
});

it('acknowledges events after the handler runs', () => {
  const { socket, realtime } = setup();
  const seen: unknown[] = [];
  const off = realtime.on('chat.events', value => { seen.push(value); });
  const ack = jest.fn();
  socket.fire('chat.events', { n: 1 }, ack);
  expect(seen).toEqual([{ n: 1 }]);
  expect(ack).toHaveBeenCalledTimes(1);
  off();
  socket.fire('chat.events', { n: 2 });
  expect(seen).toHaveLength(1);
});

it('stop disconnects and start reconnects', () => {
  const { socket, realtime } = setup();
  realtime.start(); socket.open();
  realtime.stop();
  expect(socket.connected).toBe(false);
  realtime.start();
  expect(socket.connects).toHaveLength(2);
});
