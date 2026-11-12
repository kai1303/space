import { Server } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import { AppError, chatCursor, record, uuid, parseTypingInput, TYPING_TTL_MS, type TypingEvent } from '@space/contracts';
import type { IncomingHttpHeaders } from 'node:http';
import type { ChatStore } from '@space/postgres/chat';
import { EventBus } from '@space/events';
import type { RedisSocketAdapter } from '@space/redis';
import { parseResourceSubscription, resourceRevision, type ResourceSubscription } from './resource-updates.js';
import { RealtimeWork, SubscriptionIndex } from './realtime-work.js';
import { deliveryHealth } from './realtime-health.js';
import { TypingListeners } from './realtime-typing.js';
import { liveReceipts, type ReceiptMetrics } from './live-receipts.js';

export interface RealtimeOptions { receiptMetrics?: ReceiptMetrics; adapter?: RedisSocketAdapter; allowedOrigins?: string[]; strictOrigins?: boolean; events?: EventBus; eventUrl?: string; maxConnections?: number; maxActorConnections?: number; workConcurrency?: number; workQueue?: number }
const failure = (error: unknown) => ({ error: error instanceof AppError ? error.code : 'internal_error' });

export function registerRealtime(app: FastifyInstance, authenticate: (headers: IncomingHttpHeaders, socketToken?: unknown) => Promise<string>, chat: ChatStore, options: RealtimeOptions = {}) {
  const work = new RealtimeWork(options.workConcurrency, options.workQueue);
  const maxConnections = options.maxConnections ?? 1000, maxActorConnections = options.maxActorConnections ?? 8;
  if (![maxConnections, maxActorConnections].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('invalid realtime connection limits');
  const actors = new Map<string, number>();
  let rejectedConnections = 0, ackTimeouts = 0;
  const io = new Server(app.server, {
    transports: ['websocket'], maxHttpBufferSize: 131072, serveClient: false,
    allowRequest: (request, done) => {
      if (io.engine.clientsCount >= maxConnections) { rejectedConnections++; done(null, false); return; }
      const origin = request.headers.origin;
      let allowed = !origin;
      try { allowed ||= (!options.strictOrigins && new URL(origin!).host === request.headers.host) || !!options.allowedOrigins?.includes(origin!); } catch { /* Invalid origin. */ }
      done(null, allowed);
    },
  });
  // Enforce the cap again after upgrade to cover simultaneous handshakes.
  io.engine.on('connection', connection => { if (io.engine.clientsCount > maxConnections) { rejectedConnections++; connection.close(true); } });
  const outboxListeners = new Set<(keys?: readonly string[]) => void>();
  const subscriptions = new SubscriptionIndex();
  const wake = (keys?: readonly string[]) => {
    subscriptions.wake(keys);
    for (const listener of outboxListeners) listener(keys);
  };
  let events: Promise<EventBus> | undefined;
  const getEvents = () => events ??= (async () => {
    const schema = (await chat.pool.query<{schema:string}>('SELECT current_schema() AS schema')).rows[0]!.schema;
    const bus = options.events ?? new EventBus(options.eventUrl ?? process.env.NATS_URL ?? process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222', schema);
    await bus.start(); return bus;
  })();
  io.use(async (socket, next) => {
    const owner = socket.id;
    socket.conn.once('close', () => work.cancel(owner));
    try {
      const token: unknown = socket.handshake.auth.token;
      const actor = await work.run(owner, () => authenticate(socket.handshake.headers, token));
      if (socket.conn.readyState !== 'open') return;
      const count = actors.get(actor) ?? 0;
      if (count >= maxActorConnections) { rejectedConnections++; next(new Error('connection_limit')); return; }
      actors.set(actor, count + 1);
      socket.conn.once('close', () => { const remaining = (actors.get(actor) ?? 1) - 1; if (remaining) actors.set(actor, remaining); else actors.delete(actor); });
      socket.data.actor = actor;
      socket.data.token = token;
      next();
    } catch (error) { next(new Error(failure(error).error)); }
  });
  // Transient fanout uses the existing Redis adapter; no message history or replay.
  const typingListeners = new TypingListeners();
  const sidebarTyping = new TypingListeners();
  const receiveTyping = (event: TypingEvent, peerKey?: string) => {
    typingListeners.publish(event);
    if (peerKey && !event.thread_id) sidebarTyping.publish(event, peerKey);
  };
  io.on('space.typing',receiveTyping);
  const publishTyping = (event: TypingEvent, peerKey?: string) => {
    receiveTyping(event, peerKey);
    if (options.adapter?.isReady) io.serverSideEmit('space.typing', event, peerKey);
  };
  const receipts = options.receiptMetrics && liveReceipts(io, options.receiptMetrics, () => !!options.adapter?.isReady);
  io.on('connection', socket => {
    const receiptSender = socket.handshake.auth.live_receipts === 1 ? receipts?.sender(socket) : undefined;
    if (receiptSender) socket.emit('chat.receipts.enabled');
    type Resource = ResourceSubscription & { wake: () => void; stop: () => void };
    type Channel = { channel: string; cursor: string; wake: () => void; stop: () => void };
    type Workspace = { id: string; snapshot?: string; wake: () => void; stop: () => void };
    const resources = new Map<string, Resource>();
    const resourceKey = (value: ResourceSubscription) => `${value.scope}:${value.id}`;
    let subscription: Channel | undefined;
    let workspace: Workspace | undefined;
    let command = false;
    let windowStart = Date.now(), controls = 0, messages = 0, typingControls = 0;
    let authenticating: Promise<void> | undefined;
    const authorize = () => authenticating ??= (async () => {
      if (await authenticate(socket.handshake.headers, socket.data.token) !== socket.data.actor) throw new AppError(401, 'unauthorized');
    })().finally(() => { authenticating = undefined; });
    const disconnect = (error: unknown) => {
      if (!socket.connected) return;
      socket.emit('chat.error', failure(error));
      socket.disconnect(true);
    };
    const typing=new Map<string,{event:TypingEvent;peerKey?:string;timer:NodeJS.Timeout}>();
    let stopTypingListener:(()=>void)|undefined;
    const stopTyping=(thread?:string|null)=>{
      for(const [key,entry] of typing){
        if(thread!==undefined&&entry.event.thread_id!==thread)continue;
        clearTimeout(entry.timer);typing.delete(key);publishTyping({...entry.event,active:false,expires_at:Date.now()},entry.peerKey);
      }
    };
    const leaveTyping=()=>{stopTyping();stopTypingListener?.();stopTypingListener=undefined;};
    // Each stream keeps one in-flight page and one coalesced wake, so a slow ACK cannot stall other streams.
    const boundedPump = (active: () => boolean, read: () => Promise<void | (() => Promise<void>)>, revoke?: (error: unknown) => void) => {
      let running = false, pending = false;
      const wake = () => {
        if (!socket.connected || !active()) return;
        pending = true;
        if (running) return;
        running = true;
        void (async () => {
          try {
            while (pending && socket.connected && active()) {
              pending = false;
              const deliver = await work.run(socket.id, async () => {
                if (!socket.connected || !active()) return;
                await authorize();
                if (socket.connected && active()) return read();
              });
              // Browser ACK latency must not occupy the database concurrency budget.
              if (deliver && socket.connected && active()) await deliver();
            }
          } catch (error) {
            if (!socket.connected || !active()) return;
            if (revoke && error instanceof AppError && [403, 404].includes(error.status)) revoke(error);
            else disconnect(error);
          } finally { running = false; }
        })();
      };
      return wake;
    };
    const emit = async (event: string, value: unknown) => {
      try { return await socket.timeout(5000).emitWithAck(event, value); }
      catch { ackTimeouts++; throw new AppError(408, 'ack_timeout'); }
    };
    const authPump = boundedPump(() => true, async () => {});
    const stopAuth = subscriptions.add(['global', `actor:${socket.data.actor}`], authPump);
    socket.on('disconnect', () => { leaveTyping(); stopAuth(); for (const resource of resources.values()) resource.stop(); resources.clear(); subscription?.stop(); subscription = undefined; workspace?.stop(); workspace = undefined; work.cancel(socket.id); });
    const handle = (name: string, action: (input: unknown) => Promise<unknown>) => {
      socket.on(name, async (input: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); controls = 0; messages = 0; typingControls = 0; }
        const limited = name === 'typing.change' ? ++typingControls > 4 : name === 'message.send' ? ++messages > 30 : ++controls > 128;
        if (limited || command) { ack({ error: 'busy' }); return; }
        command = true;
        try {
          const data = await work.run(socket.id, async () => {
            if (!socket.connected) return;
            await authorize();
            if (socket.connected) return action(input);
          });
          if (socket.connected) ack({ data });
        } catch (error) {
          ack(failure(error));
          if (!(error instanceof AppError) || error.status === 401 || error.status >= 500) disconnect(error);
        }
        finally { command = false; }
      });
    };
    handle('updates.subscribe', async input => {
      const next = parseResourceSubscription(input), key = resourceKey(next);
      if (resources.has(key)) return { scope: next.scope, id: next.id };
      if (resources.size >= 64) throw new AppError(429, 'subscription_limit');
      await resourceRevision(chat, socket.data.actor, next);
      if (!socket.connected) return;
      const current: Resource = { ...next, wake: () => {}, stop: () => {} };
      const active = () => resources.get(key) === current;
      current.wake = boundedPump(active, async () => {
        const revision = await resourceRevision(chat, socket.data.actor, current);
        if (!active() || !socket.connected || current.revision === revision) return;
        return async () => {
          await emit('updates.changed', { scope: current.scope, id: current.id });
          if (active()) current.revision = revision;
        };
      }, error => {
        current.stop();
        resources.delete(key);
        socket.emit('updates.revoked', { scope: current.scope, id: current.id, ...failure(error) });
      });
      resources.set(key, current);
      current.stop = subscriptions.add(current.keys!, current.wake);
      setImmediate(current.wake);
      return { scope: next.scope, id: next.id };
    });
    handle('updates.unsubscribe', async input => {
      const value = parseResourceSubscription(input);
      resources.get(resourceKey(value))?.stop(); resources.delete(resourceKey(value));
      return value;
    });
    handle('workspace.subscribe', async input => {
      const v = record(input, ['workspace_id']);
      const id = uuid(v.workspace_id);
      await chat.unread.summary(socket.data.actor, id);
      if (!socket.connected) return;
      const current: Workspace = { id, wake: () => {}, stop: () => {} };
      const active = () => workspace === current;
      current.wake = boundedPump(active, async () => {
        const snapshot = await chat.unread.summary(socket.data.actor, id), serialized = JSON.stringify(snapshot);
        if (!active() || !socket.connected || current.snapshot === serialized) return;
        return async () => {
          await emit('workspace.unread', snapshot);
          if (active()) current.snapshot = serialized;
        };
      }, error => {
        current.stop();
        workspace = undefined;
        socket.emit('workspace.revoked', { workspace_id: id, ...failure(error) });
      });
      workspace?.stop(); workspace = current;
      const stopUnread = subscriptions.add(['global', `actor:${socket.data.actor}`, `workspace:${id}`, `unread:${id}`, `unread-user:${id}:${socket.data.actor}`], current.wake);
      const stopSidebar = sidebarTyping.subscribe({
        key: `${id}:${socket.data.actor}`, socketId: socket.id, pump: boundedPump, active,
        authorizeEvents: async events => {
          const channels = await chat.directMessages.visibleTypingChannels(socket.data.actor, id, [...new Set(events.map(e => e.channel_id))]);
          return events.filter(event => channels.has(event.channel_id));
        },
        emit: event => socket.volatile.emit('workspace.dm-typing', {...event, workspace_id: id}),
        revoke: disconnect,
      });
      current.stop = () => { stopUnread(); stopSidebar(); };
      setImmediate(current.wake);
      return { workspace_id: id };
    });
    handle('workspace.unsubscribe', async input => {
      const v = record(input, ['workspace_id']), id = uuid(v.workspace_id);
      if (workspace?.id === id) { workspace.stop(); workspace = undefined; }
      return { workspace_id: id };
    });
    handle('channel.subscribe', async input => {
      const v = record(input, ['channel_id', 'after']);
      const channel = uuid(v.channel_id), cursor = chatCursor(v.after);
      await chat.events(socket.data.actor, channel, cursor);
      const ref = (await chat.pool.query<{workspace_id:string; event_sequence:string}>('SELECT workspace_id, event_sequence::text FROM channels WHERE id=$1',[channel])).rows[0];
      if (!ref) throw new AppError(404, 'not_found');
      if (!socket.connected) return;
      const liveAfter = receiptSender ? BigInt(ref.event_sequence) : 0n;
      const current: Channel = { channel, cursor, wake: () => {}, stop: () => {} };
      const active = () => subscription === current;
      const revoke = (error: unknown) => {
        current.stop();
        leaveTyping(); subscription = undefined;
        socket.emit('channel.revoked', { channel_id: channel, ...failure(error) });
      };
      current.wake = boundedPump(active, async () => {
        const events = await chat.events(socket.data.actor, channel, current.cursor);
        if (!active() || !socket.connected || !events.length) return;
        const next = events.at(-1)!.sequence;
        return async () => {
          const ids = receiptSender ? receipts!.candidates(events, socket.data.actor, liveAfter) : [];
          const accepted = await emit('chat.events', { channel_id: channel, events, cursor: next, ...(ids.length ? { receipt_requested: true } : {}) });
          if (!active()) return;
          if (ids.length && accepted === true) receipts!.received(ids);
          current.cursor = next;
          if (events.length === 100) current.wake();
        };
      }, revoke);
      leaveTyping();subscription?.stop();subscription = current;
      current.stop = subscriptions.add(['global', `actor:${socket.data.actor}`, `workspace:${ref.workspace_id}`, `channel:${channel}`, `channel-events:${channel}`], current.wake);
      stopTypingListener = typingListeners.subscribe({
        key: channel, socketId: socket.id, pump: boundedPump, active, revoke,
        authorizeEvents: async events => {
          const access = await chat.typingActor(socket.data.actor, channel);
          return access.archived ? events.map(event => ({...event, active: false})) : events;
        },
        emit: event => socket.volatile.emit('chat.typing', event),
      });
      setImmediate(current.wake);
      return { channel_id: channel, cursor };
    });
    handle('channel.unsubscribe', async input => {
      const v = record(input, ['channel_id']), channel = uuid(v.channel_id);
      if (subscription?.channel === channel) {leaveTyping();subscription.stop();subscription = undefined;}
      return { channel_id: channel };
    });
    handle('typing.change', async input=>{
      const value=parseTypingInput(input);
      const current=subscription;
      if(current?.channel!==value.channel_id)throw new AppError(404,'not_found');
      const access=await chat.typingActor(socket.data.actor,value.channel_id,value.thread_id);
      if(!socket.connected||subscription!==current)return value;
      if(access.archived&&value.active)throw new AppError(409,'channel_archived');
      const key=value.thread_id??'';
      if(!value.active){stopTyping(value.thread_id);return value;}
      // One channel and one thread per socket keep activity and timers bounded.
      if(value.thread_id)for(const entry of typing.values())if(entry.event.thread_id&&entry.event.thread_id!==value.thread_id)stopTyping(entry.event.thread_id);
      clearTimeout(typing.get(key)?.timer);
      const event:TypingEvent={...value,source_id:socket.id,user:access.user,expires_at:Date.now()+TYPING_TTL_MS};
      const timer=setTimeout(()=>stopTyping(value.thread_id),TYPING_TTL_MS);timer.unref();
      const peerKey = access.sidebarPeer ? `${access.workspace}:${access.sidebarPeer}` : undefined;
      typing.set(key,{event,timer,peerKey});publishTyping(event,peerKey);return value;
    });
    handle('message.send', async input => {
      const v = record(input, ['channel_id', 'client_message_id', 'text', 'thread_id', 'document', 'asset_ids', 'asset_descriptions', 'broadcast_confirmed', 'receipt_id', 'expected_actor']);
      const { channel_id, receipt_id, expected_actor, ...message } = v;
      if (expected_actor !== undefined && uuid(expected_actor) !== socket.data.actor) throw new AppError(409, 'actor_changed');
      const channel = uuid(channel_id);
      const sample = receiptSender && receipt_id !== undefined ? receiptSender(uuid(receipt_id)) : undefined;
      try {
        const saved = await chat.send(socket.data.actor, channel, message, sample?.id);
        if (sample && saved.id !== sample.id) sample.finish('duplicate');
        stopTyping(typeof message.thread_id === 'string' ? message.thread_id : null);
        return saved;
      } catch (error) {
        sample?.finish('send_failed');
        throw error;
      }
    });
  });
  let stopEvents: (() => Promise<void>) | undefined, stopReconnect: (() => void) | undefined;
  let stopAdapterReady: (() => void) | undefined;
  let closing = false, rebinding: Promise<void> | undefined, retrySubscription: NodeJS.Timeout | undefined;
  let consumerReady = false;
  app.addHook('onReady', async () => {
    if (options.adapter) {
      let installed = false;
      stopAdapterReady = options.adapter.onReady(() => {
        if (installed || closing) return;
        installed = true;
        const sockets = [io.of('/'), io.of('/agents')].flatMap(namespace => [...namespace.sockets.values()])
          .map(socket => ({socket, rooms: [...socket.rooms]}));
        io.adapter(options.adapter!.adapter);
        for (const {socket, rooms} of sockets) void socket.join(rooms);
      });
    }
    const bus = await getEvents();
    const subscribe = () => {
      let lastSequence: number | undefined;
      return bus.subscribe('chat.changed.*', {maxPending:64, onError: () => { consumerReady = false; rebind(); }}, async message => {
        const keys = message.event.data.keys;
        const gap = lastSequence !== undefined && message.sequence !== undefined && message.sequence > lastSequence+1;
        if (message.sequence !== undefined) lastSequence = Math.max(lastSequence ?? 0,message.sequence);
        // Bounded realtime retention may drop hints during overload; history remains authoritative.
        // Legacy notifications intentionally fall back to full catch-up during rolling upgrades.
        if (gap || !Array.isArray(keys) || !keys.every(key => typeof key === 'string')) wake(); else wake(keys);
        await message.ack();
      });
    };
    const rebind = () => {
      if (closing || rebinding) return;
      consumerReady = false;
      clearTimeout(retrySubscription);
      rebinding = (async () => {
        const previous = stopEvents; stopEvents = undefined;
        // A disconnect can reject the old consumer's final flush. It must not poison reattachment.
        await previous?.().catch(() => {});
        if (closing) return;
        const stop = await subscribe();
        if (closing) await stop(); else { stopEvents = stop; consumerReady = true; wake(); }
      })().catch(() => {
        if (!closing) retrySubscription = setTimeout(rebind,1000);
      }).finally(() => { rebinding = undefined; });
    };
    stopEvents = await subscribe(); consumerReady = true;
    // Ephemeral consumers can expire during an outage; attach a new one before catch-up.
    stopReconnect = bus.onReconnect(rebind);
    wake();
  });
  app.addHook('preClose', async () => {
    closing = true; consumerReady = false; clearTimeout(retrySubscription); stopReconnect?.(); stopAdapterReady?.();
    await rebinding; await stopEvents?.().catch(() => {});
    io.local.disconnectSockets(true);
  });
  app.addHook('onClose', async () => {
    await new Promise<void>(resolve => { io.close(() => resolve()); });
    await options.adapter?.close();
    if (events && !options.events) await (await events.catch(() => undefined))?.close();
  });
  const checkHealth = async () => {
    const bus = await getEvents();
    const cdc = await work.run('health', () => deliveryHealth(chat.pool, bus.schema));
    const ready = !closing && bus.isConnected && consumerReady && cdc.ready && work.stats().queued < work.capacity;
    return { ready, broker: bus.isConnected, consumer: consumerReady, cdc, typing: options.adapter?.isReady ?? false,
      connections: io.engine.clientsCount, rejectedConnections, ackTimeouts, work: work.stats(),
      database: { connections: chat.pool.totalCount, waiting: chat.pool.waitingCount } };
  };
  let checkingHealth: ReturnType<typeof checkHealth> | undefined;
  const health = () => checkingHealth ??= checkHealth().finally(() => { checkingHealth = undefined; });
  return { io, getEvents, work, health, invalidate: wake,
    onOutbox: (listener: (keys?: readonly string[]) => void) => { outboxListeners.add(listener); return () => { outboxListeners.delete(listener); }; } };
}
