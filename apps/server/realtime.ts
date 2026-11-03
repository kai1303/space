import { Server } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import { AppError, chatCursor, record, uuid } from '@space/contracts';
import type { IncomingHttpHeaders } from 'node:http';
import type { ChatStore } from '@space/postgres/chat';

export interface ChatSignals {
  listen(wake: () => void): Promise<void>;
  publish(): Promise<void>;
}
export interface RealtimeOptions { signals?: ChatSignals; reconcileMs?: number; allowedOrigins?: string[]; strictOrigins?: boolean }
const failure = (error: unknown) => ({ error: error instanceof AppError ? error.code : 'internal_error' });

export function registerRealtime(app: FastifyInstance, authenticate: (headers: IncomingHttpHeaders, socketToken?: unknown) => Promise<string>, chat: ChatStore, options: RealtimeOptions = {}) {
  const io = new Server(app.server, {
    transports: ['websocket'], maxHttpBufferSize: 131072, serveClient: false,
    allowRequest: (request, done) => {
      const origin = request.headers.origin;
      let allowed = !origin;
      try { allowed ||= (!options.strictOrigins && new URL(origin!).host === request.headers.host) || !!options.allowedOrigins?.includes(origin!); } catch { /* Invalid origin. */ }
      done(null, allowed);
    },
  });
  const pumps = new Set<() => void>();
  const wake = () => { for (const pump of pumps) pump(); };
  const notify = async () => { wake(); await options.signals?.publish(); };
  io.use(async (socket, next) => {
    try {
      const token: unknown = socket.handshake.auth.token;
      socket.data.actor = await authenticate(socket.handshake.headers, token);
      socket.data.token = token;
      next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', socket => {
    let subscription: { channel: string; cursor: string } | undefined;
    let running = false, pending = false, command = false;
    let windowStart = Date.now(), commands = 0;
    const pump = () => {
      pending = true;
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (pending && socket.connected) {
            pending = false;
            await authenticate(socket.handshake.headers, socket.data.token);
            const current = subscription;
            if (!current) continue;
            const events = await chat.events(socket.data.actor, current.channel, current.cursor);
            if (subscription !== current || !socket.connected) continue;
            if (!events.length) continue;
            const cursor = events.at(-1)!.sequence;
            // Bound in-flight data to one page; slow clients reconnect and replay history.
            try { await socket.timeout(5000).emitWithAck('chat.events', { channel_id: current.channel, events, cursor }); }
            catch { throw new AppError(408, 'ack_timeout'); }
            if (subscription !== current) continue;
            current.cursor = cursor;
            if (events.length === 100) pending = true;
          }
        } catch (error) {
          socket.emit('chat.error', failure(error));
          socket.disconnect(true);
        } finally { running = false; }
      })();
    };
    pumps.add(pump);
    socket.on('disconnect', () => { subscription = undefined; pumps.delete(pump); });
    const handle = (name: string, action: (input: unknown) => Promise<unknown>) => {
      socket.on(name, async (input: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); commands = 0; }
        if (++commands > 30 || command) { ack({ error: 'busy' }); return; }
        command = true;
        try {
          await authenticate(socket.handshake.headers, socket.data.token);
          ack({ data: await action(input) });
        } catch (error) { ack(failure(error)); }
        finally { command = false; }
      });
    };
    handle('channel.subscribe', async input => {
      subscription = undefined;
      const v = record(input, ['channel_id', 'after']);
      const channel = uuid(v.channel_id), cursor = chatCursor(v.after);
      await chat.events(socket.data.actor, channel, cursor);
      subscription = { channel, cursor };
      setImmediate(pump);
      return { channel_id: channel, cursor };
    });
    handle('message.send', async input => {
      const v = record(input, ['channel_id', 'client_message_id', 'text', 'thread_id', 'document', 'asset_ids']);
      const { channel_id, ...message } = v;
      const saved = await chat.send(socket.data.actor, uuid(channel_id), message);
      await notify();
      return saved;
    });
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => {
    await options.signals?.listen(wake);
    timer = setInterval(wake, options.reconcileMs ?? 10_000);
    timer.unref();
  });
  app.addHook('preClose', async () => { clearInterval(timer); io.disconnectSockets(true); });
  app.addHook('onClose', async () => { io.close(); });
  // Includes membership/token changes and task mutations committed through HTTP.
  app.addHook('onResponse', async (request, reply) => {
    if (['POST', 'PATCH', 'DELETE'].includes(request.method) && reply.statusCode < 400) await notify();
  });
  return { notify, io };
}
