import { Server } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import { AppError, chatCursor, record, uuid } from '@space/contracts';
import type { IncomingHttpHeaders } from 'node:http';
import type { ChatStore } from '@space/postgres/chat';
import { relayChatOutbox } from '@space/postgres/chat-outbox';
import type { RedisSocketAdapter } from '@space/redis';

export interface RealtimeOptions { adapter?: RedisSocketAdapter; reconcileMs?: number; outboxMs?: number; allowedOrigins?: string[]; strictOrigins?: boolean }
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
  const pumps = new Set<(channels?: (string | null)[]) => void>();
  const wake = (channels?: (string | null)[]) => { for (const pump of pumps) pump(channels); };
  io.on('chat.outbox', (channels: (string | null)[], ack: () => void) => { wake(channels); ack(); });
  const publish = async (channels: (string | null)[]) => {
    if (options.adapter && !options.adapter.isReady) throw new Error('redis_unavailable');
    wake(channels);
    if (!options.adapter) return;
    // Adapter acknowledgement is required; emit() alone does not confirm publication.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        io.serverSideEmitWithAck('chat.outbox', channels),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('adapter_timeout')), 3000); }),
      ]);
    } finally { clearTimeout(timeout); }
  };
  io.use(async (socket, next) => {
    try {
      const token: unknown = socket.handshake.auth.token;
      socket.data.actor = await authenticate(socket.handshake.headers, token);
      socket.data.token = token;
      next();
    } catch (error) { next(new Error(failure(error).error)); }
  });
  io.on('connection', socket => {
    let subscription: { channel: string; cursor: string } | undefined;
    let workspace: { id: string; snapshot?: string } | undefined;
    let running = false, pending = false, command = false;
    let windowStart = Date.now(), commands = 0;
    const pump = (channels?: (string | null)[]) => {
      if (!workspace && channels && !channels.includes(null) && (!subscription || !channels.includes(subscription.channel))) return;
      pending = true;
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (pending && socket.connected) {
            pending = false;
            await authenticate(socket.handshake.headers, socket.data.token);
            const currentWorkspace = workspace;
            if (currentWorkspace) {
              const snapshot = await chat.unread.summary(socket.data.actor, currentWorkspace.id);
              const serialized = JSON.stringify(snapshot);
              if (workspace === currentWorkspace && socket.connected && currentWorkspace.snapshot !== serialized) {
                try { await socket.timeout(5000).emitWithAck('workspace.unread', snapshot); }
                catch { throw new AppError(408, 'ack_timeout'); }
                if (workspace === currentWorkspace) currentWorkspace.snapshot = serialized;
              }
            }
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
    socket.on('disconnect', () => { subscription = undefined; workspace = undefined; pumps.delete(pump); });
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
    handle('workspace.subscribe', async input => {
      workspace = undefined;
      const v = record(input, ['workspace_id']);
      const id = uuid(v.workspace_id);
      await chat.unread.summary(socket.data.actor, id);
      workspace = { id };
      setImmediate(() => pump());
      return { workspace_id: id };
    });
    handle('channel.subscribe', async input => {
      subscription = undefined;
      const v = record(input, ['channel_id', 'after']);
      const channel = uuid(v.channel_id), cursor = chatCursor(v.after);
      await chat.events(socket.data.actor, channel, cursor);
      subscription = { channel, cursor };
      setImmediate(() => pump());
      return { channel_id: channel, cursor };
    });
    handle('message.send', async input => {
      const v = record(input, ['channel_id', 'client_message_id', 'text', 'thread_id', 'document', 'asset_ids', 'broadcast_confirmed']);
      const { channel_id, ...message } = v;
      return chat.send(socket.data.actor, uuid(channel_id), message);
    });
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let outboxTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false, publishing: Promise<void> | undefined;
  const drain = () => {
    if (stopped || publishing) return;
    publishing = (async () => {
      try {
        // Bound each pass so a busy outbox still yields to shutdown and API traffic.
        for (let page = 0; page < 10 && !stopped; page++) {
          if (await relayChatOutbox(chat.pool, publish) < 100) break;
        }
      } catch { app.log.warn('chat_outbox_publish_failed'); }
      finally { publishing = undefined; }
    })();
  };
  app.addHook('onReady', async () => {
    if (options.adapter) io.adapter(options.adapter.adapter);
    timer = setInterval(() => wake(), options.reconcileMs ?? 10_000);
    timer.unref();
    outboxTimer = setInterval(drain, options.outboxMs ?? 250);
    outboxTimer.unref();
    drain();
  });
  app.addHook('preClose', async () => {
    stopped = true; clearInterval(timer); clearInterval(outboxTimer);
    await publishing;
    io.local.disconnectSockets(true);
  });
  app.addHook('onClose', async () => {
    await new Promise<void>(resolve => { io.close(() => resolve()); });
    await options.adapter?.close();
  });
  return { io };
}
