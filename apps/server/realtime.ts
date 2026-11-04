import { Server } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import { AppError, chatCursor, record, uuid, parseTypingInput, TYPING_TTL_MS, type TypingEvent } from '@space/contracts';
import type { IncomingHttpHeaders } from 'node:http';
import type { ChatStore } from '@space/postgres/chat';
import { EventBus } from '@space/events';
import type { RedisSocketAdapter } from '@space/redis';
import { parseResourceSubscription, resourceRevision, type ResourceSubscription } from './resource-updates.js';

export interface RealtimeOptions { adapter?: RedisSocketAdapter; allowedOrigins?: string[]; strictOrigins?: boolean; events?: EventBus; eventUrl?: string }
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
  const outboxListeners = new Set<() => void>();
  const pumps = new Set<(channels?: (string | null)[]) => void>();
  const wake = (channels?: (string | null)[]) => {
    for (const pump of pumps) pump(channels);
    for (const listener of outboxListeners) listener();
  };
  let events: Promise<EventBus> | undefined;
  const getEvents = () => events ??= (async () => {
    const schema = (await chat.pool.query<{schema:string}>('SELECT current_schema() AS schema')).rows[0]!.schema;
    const bus = options.events ?? new EventBus(options.eventUrl ?? process.env.NATS_URL ?? process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222', schema);
    await bus.start(); return bus;
  })();
  io.use(async (socket, next) => {
    try {
      const token: unknown = socket.handshake.auth.token;
      socket.data.actor = await authenticate(socket.handshake.headers, token);
      socket.data.token = token;
      next();
    } catch (error) { next(new Error(failure(error).error)); }
  });
  // Transient fanout uses the existing Redis adapter; no message history or replay.
  const typingListeners=new Map<string,Set<(event:TypingEvent)=>void>>();
  const receiveTyping=(event:TypingEvent)=>{for(const listener of typingListeners.get(event.channel_id)??[])listener(event);};
  io.on('space.typing',receiveTyping);
  const publishTyping=(event:TypingEvent)=>{receiveTyping(event);if(options.adapter?.isReady)io.serverSideEmit('space.typing',event);};
  io.on('connection', socket => {
    type Resource = ResourceSubscription & { wake: () => void };
    type Channel = { channel: string; cursor: string; wake: () => void };
    type Workspace = { id: string; snapshot?: string; wake: () => void };
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
    const typing=new Map<string,{event:TypingEvent;timer:NodeJS.Timeout}>();
    const typingPending=new Map<string,TypingEvent>();
    let stopTypingListener:(()=>void)|undefined;
    const stopTyping=(thread?:string|null)=>{
      for(const [key,entry] of typing){
        if(thread!==undefined&&entry.event.thread_id!==thread)continue;
        clearTimeout(entry.timer);typing.delete(key);publishTyping({...entry.event,active:false,expires_at:Date.now()});
      }
    };
    const leaveTyping=()=>{stopTyping();stopTypingListener?.();stopTypingListener=undefined;typingPending.clear();};
    // Each stream keeps one in-flight page and one coalesced wake, so a slow ACK cannot stall other streams.
    const boundedPump = (active: () => boolean, read: () => Promise<void>, revoke?: (error: unknown) => void) => {
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
              await authorize();
              if (!socket.connected || !active()) return;
              await read();
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
      try { await socket.timeout(5000).emitWithAck(event, value); }
      catch { throw new AppError(408, 'ack_timeout'); }
    };
    const authPump = boundedPump(() => true, async () => {});
    const pump = (channels?: (string | null)[]) => {
      authPump();
      for (const resource of resources.values()) resource.wake();
      workspace?.wake();
      if (!channels || channels.includes(null) || (subscription && channels.includes(subscription.channel))) subscription?.wake();
    };
    const typingPump=boundedPump(()=>!!subscription,async()=>{
      const current=subscription!;
      const pending=[...typingPending.values()];typingPending.clear();
      const access=await chat.typingActor(socket.data.actor,current.channel);
      if(subscription!==current||!socket.connected)return;
      for(const event of pending){if(!event.active||event.expires_at>Date.now())socket.volatile.emit('chat.typing',access.archived?{...event,active:false}:event);}
    },error=>{leaveTyping();const channel=subscription?.channel;subscription=undefined;socket.emit('channel.revoked',{channel_id:channel,...failure(error)});});
    const typingListener=(event:TypingEvent)=>{
      if(event.channel_id!==subscription?.channel||event.source_id===socket.id)return;
      const key=`${event.source_id}:${event.thread_id??''}`;
      if(!typingPending.has(key)&&typingPending.size>=64)typingPending.delete(typingPending.keys().next().value!);
      typingPending.set(key,event);typingPump();
    };
    pumps.add(pump);
    socket.on('disconnect', () => { leaveTyping(); resources.clear(); subscription = undefined; workspace = undefined; pumps.delete(pump); });
    const handle = (name: string, action: (input: unknown) => Promise<unknown>) => {
      socket.on(name, async (input: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); controls = 0; messages = 0; typingControls = 0; }
        const limited = name === 'typing.change' ? ++typingControls > 4 : name === 'message.send' ? ++messages > 30 : ++controls > 128;
        if (limited || command) { ack({ error: 'busy' }); return; }
        command = true;
        try {
          await authorize();
          if (!socket.connected) return;
          ack({ data: await action(input) });
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
      const current: Resource = { ...next, wake: () => {} };
      const active = () => resources.get(key) === current;
      current.wake = boundedPump(active, async () => {
        const revision = await resourceRevision(chat, socket.data.actor, current);
        if (!active() || !socket.connected || current.revision === revision) return;
        await emit('updates.changed', { scope: current.scope, id: current.id });
        if (active()) current.revision = revision;
      }, error => {
        resources.delete(key);
        socket.emit('updates.revoked', { scope: current.scope, id: current.id, ...failure(error) });
      });
      resources.set(key, current);
      setImmediate(current.wake);
      return { scope: next.scope, id: next.id };
    });
    handle('updates.unsubscribe', async input => {
      const value = parseResourceSubscription(input);
      resources.delete(resourceKey(value));
      return value;
    });
    handle('workspace.subscribe', async input => {
      const v = record(input, ['workspace_id']);
      const id = uuid(v.workspace_id);
      await chat.unread.summary(socket.data.actor, id);
      if (!socket.connected) return;
      const current: Workspace = { id, wake: () => {} };
      const active = () => workspace === current;
      current.wake = boundedPump(active, async () => {
        const snapshot = await chat.unread.summary(socket.data.actor, id), serialized = JSON.stringify(snapshot);
        if (!active() || !socket.connected || current.snapshot === serialized) return;
        await emit('workspace.unread', snapshot);
        if (active()) current.snapshot = serialized;
      }, error => {
        workspace = undefined;
        socket.emit('workspace.revoked', { workspace_id: id, ...failure(error) });
      });
      workspace = current;
      setImmediate(current.wake);
      return { workspace_id: id };
    });
    handle('workspace.unsubscribe', async input => {
      const v = record(input, ['workspace_id']), id = uuid(v.workspace_id);
      if (workspace?.id === id) workspace = undefined;
      return { workspace_id: id };
    });
    handle('channel.subscribe', async input => {
      const v = record(input, ['channel_id', 'after']);
      const channel = uuid(v.channel_id), cursor = chatCursor(v.after);
      await chat.events(socket.data.actor, channel, cursor);
      if (!socket.connected) return;
      const current: Channel = { channel, cursor, wake: () => {} };
      const active = () => subscription === current;
      current.wake = boundedPump(active, async () => {
        const events = await chat.events(socket.data.actor, channel, current.cursor);
        if (!active() || !socket.connected || !events.length) return;
        const next = events.at(-1)!.sequence;
        await emit('chat.events', { channel_id: channel, events, cursor: next });
        if (!active()) return;
        current.cursor = next;
        if (events.length === 100) current.wake();
      }, error => {
        leaveTyping(); subscription = undefined;
        socket.emit('channel.revoked', { channel_id: channel, ...failure(error) });
      });
      leaveTyping();subscription = current;
      const listeners=typingListeners.get(channel)??new Set();listeners.add(typingListener);typingListeners.set(channel,listeners);
      stopTypingListener=()=>{listeners.delete(typingListener);if(!listeners.size)typingListeners.delete(channel);};
      setImmediate(current.wake);
      return { channel_id: channel, cursor };
    });
    handle('channel.unsubscribe', async input => {
      const v = record(input, ['channel_id']), channel = uuid(v.channel_id);
      if (subscription?.channel === channel) {leaveTyping();subscription = undefined;}
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
      typing.set(key,{event,timer});publishTyping(event);return value;
    });
    handle('message.send', async input => {
      const v = record(input, ['channel_id', 'client_message_id', 'text', 'thread_id', 'document', 'asset_ids', 'broadcast_confirmed']);
      const { channel_id, ...message } = v;
      const saved=await chat.send(socket.data.actor, uuid(channel_id), message);
      stopTyping(typeof message.thread_id==='string'?message.thread_id:null);return saved;
    });
  });
  let stopEvents: (() => Promise<void>) | undefined, stopReconnect: (() => void) | undefined;
  let closing = false, rebinding: Promise<void> | undefined, retrySubscription: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    if (options.adapter) io.adapter(options.adapter.adapter);
    const bus = await getEvents();
    const subscribe = () => {
      let lastSequence: number | undefined;
      return bus.subscribe('chat.changed.*', {maxPending:64}, async message => {
        const channel = message.event.data.channel_id;
        const gap = lastSequence !== undefined && message.sequence !== undefined && message.sequence > lastSequence+1;
        if (message.sequence !== undefined) lastSequence = Math.max(lastSequence ?? 0,message.sequence);
        // Bounded realtime retention may drop hints during overload; history remains authoritative.
        if (gap) wake(); else wake([typeof channel === 'string' ? channel : null]);
        await message.ack();
      });
    };
    stopEvents = await subscribe();
    const rebind = () => {
      if (closing || rebinding) return;
      clearTimeout(retrySubscription);
      rebinding = (async () => {
        await stopEvents?.(); stopEvents = undefined;
        if (closing) return;
        const stop = await subscribe();
        if (closing) await stop(); else { stopEvents = stop; wake(); }
      })().catch(() => {
        if (!closing) retrySubscription = setTimeout(rebind,1000);
      }).finally(() => { rebinding = undefined; });
    };
    // Ephemeral consumers can expire during an outage; attach a new one before catch-up.
    stopReconnect = bus.onReconnect(rebind);
    wake();
  });
  app.addHook('preClose', async () => {
    closing = true; clearTimeout(retrySubscription); stopReconnect?.();
    await rebinding; await stopEvents?.();
    io.local.disconnectSockets(true);
  });
  app.addHook('onClose', async () => {
    await new Promise<void>(resolve => { io.close(() => resolve()); });
    await options.adapter?.close();
    if (events && !options.events) await (await events.catch(() => undefined))?.close();
  });
  return { io, getEvents, onOutbox: (listener: () => void) => { outboxListeners.add(listener); return () => { outboxListeners.delete(listener); }; } };
}
