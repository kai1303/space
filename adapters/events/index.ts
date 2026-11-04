import { createHash, randomUUID } from 'node:crypto';
import { connect, consumerOpts, createInbox, headers, nanos, RetentionPolicy, StorageType, DiscardPolicy, type NatsConnection, type JetStreamClient, type JsMsg } from 'nats';

export interface DomainEvent { id: string; schema: string; kind: string; aggregate_id: string; data: Record<string, unknown>; available_at?: string }
export interface EventDelivery { event: DomainEvent; sequence?: number; ack(): void | Promise<void>; retry(delayMs?: number): void | Promise<void>; progress?(): void }
export function streamName(schema: string): string { return `SPACE_${createHash('sha256').update(schema).digest('hex').slice(0, 24)}`; }
export class EventBus {
  private connection?: NatsConnection;
  private client?: JetStreamClient;
  private readonly reconnect = new Set<() => void>();
  private readonly subscriptions = new Set<() => Promise<void>>();
  readonly stream: string;
  constructor(readonly url: string, readonly schema: string, readonly instanceId: string = randomUUID()) { this.stream = streamName(schema); }
  async start(): Promise<void> {
    if (this.connection) return;
    const nc = this.connection = await connect({ servers: this.url, name: `space-${this.instanceId}`, maxReconnectAttempts: -1, reconnectTimeWait: 1000, timeout: 5000 });
    this.client = nc.jetstream({ timeout: 10000 });
    try { if (this.schema !== '*') { await this.ensureStream(this.schema, true); await this.ensureStream(this.schema, false); } }
    catch (error) { await nc.close(); this.connection = undefined; this.client = undefined; throw error; }
    void (async () => { for await (const status of nc.status()) if (status.type === 'reconnect') for (const fn of this.reconnect) fn(); })();
  }
  private readonly streams = new Set<string>();
  private readonly initializing = new Map<string, Promise<string>>();
  private async ensureStream(schema: string, chat: boolean): Promise<string> {
    const name = `${streamName(schema)}_${chat ? 'CHAT' : 'WORK'}`;
    if (this.streams.has(name)) return name;
    const existing = this.initializing.get(name);
    if (existing) return existing;
    const initialization = this.initializeStream(schema, chat);
    this.initializing.set(name, initialization);
    try { return await initialization; }
    finally { this.initializing.delete(name); }
  }
  private async initializeStream(schema: string, chat: boolean): Promise<string> {
    const prefix = streamName(schema);
    const name = `${prefix}_${chat ? 'CHAT' : 'WORK'}`;
    if (this.streams.has(name)) return name;
    if (this.streams.size >= 256) this.streams.delete(this.streams.values().next().value!);
    const manager = await this.connection!.jetstreamManager();
    const config = {
      name,
      subjects: chat ? [`${prefix}.chat.>`] : [...['task', 'navigator', 'connection', 'delivery', 'asset'].map(kind => `${prefix}.${kind}.>`), `${prefix}.schedule.>`],
      retention: chat ? RetentionPolicy.Limits : RetentionPolicy.Workqueue,
      max_age: chat ? nanos(24 * 60 * 60 * 1000) : 0,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_bytes: chat ? 16 * 1024 ** 2 : -1,
      max_msgs: -1, max_msgs_per_subject: -1,
      max_msg_size: 1024 * 1024,
      duplicate_window: nanos(120000),
      ...(!chat ? { allow_msg_schedules: true } : {}),
    };
    // Scheduling requires DiscardOld. WORK has no eviction limits; the broker's global storage limit rejects new writes.
    let exists = false;
    try { await manager.streams.info(name); exists = true; }
    catch (error) { if ((error as { code?: string }).code !== '404') throw error; }
    if (exists) await manager.streams.update(name, config);
    else {
      try { await manager.streams.add(config); }
      catch (createError) { await manager.streams.info(name).catch(() => { throw createError; }); await manager.streams.update(name, config); }
    }
    if (!chat) {
      const info = await manager.streams.info(name);
      if (!(info.config as typeof info.config & { allow_msg_schedules?: boolean }).allow_msg_schedules) throw new Error('NATS server must support persistent message schedules (2.12+)');
    }
    this.streams.add(name); return name;
  }
  async publish(event: DomainEvent): Promise<void> { await this.publishAt(event, event.available_at ? Date.parse(event.available_at) : undefined, event.id); }
  private async publishAt(event: DomainEvent, at: number | undefined, transportId: string): Promise<void> {
    if (!this.client || (this.schema !== '*' && event.schema !== this.schema)) throw new Error('event bus schema mismatch or not started');
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(event.kind) || !/^[a-zA-Z0-9_-]+$/.test(event.aggregate_id)) throw new Error('invalid event subject');
    if (at !== undefined && !Number.isFinite(at)) throw new Error('invalid event deadline');
    const chat = event.kind.startsWith('chat.');
    await this.ensureStream(event.schema, chat);
    const prefix = streamName(event.schema), target = `${prefix}.${event.kind}.${event.aggregate_id}`;
    const schedule = !chat && at !== undefined && at > Date.now();
    const metadata = headers();
    if (schedule) { metadata.set('Nats-Schedule', `@at ${new Date(at).toISOString()}`); metadata.set('Nats-Schedule-Target', target); }
    await this.client.publish(schedule ? `${prefix}.schedule.${transportId}` : target, new TextEncoder().encode(JSON.stringify(event)), { msgID: transportId, headers: metadata });
  }
  async subscribe(filter: string, options: { durable?: string; queue?: string; maxPending?: number }, handler: (delivery: EventDelivery) => Promise<void>): Promise<() => Promise<void>> {
    if (!this.client || this.schema === '*') throw new Error('event bus not started or unscoped subscriber');
    if (options.maxPending !== undefined && (!Number.isInteger(options.maxPending) || options.maxPending < 1 || options.maxPending > 1024)) throw new Error('invalid consumer concurrency');
    const opts = consumerOpts();
    opts.manualAck(); opts.ackExplicit(); opts.ackWait(300000); opts.maxAckPending(options.maxPending ?? 16);
    opts.deliverTo(options.durable ? `_SPACE_DELIVERY.${createHash('sha256').update(`${this.schema}:${options.durable}`).digest('hex')}` : createInbox());
    if (options.durable) { opts.durable(options.durable); opts.deliverAll(); } else opts.deliverNew();
    if (options.queue) opts.deliverGroup(options.queue);
    const pending = new Set<JsMsg>();
    const active = new Set<Promise<void>>();
    let stopped = false;
    opts.callback((error, message) => {
      if (error || !message) return;
      if (stopped) { message.nak(); return; }
      pending.add(message);
      let event: DomainEvent;
      try { event = JSON.parse(message.string()); if ((this.schema !== '*' && event.schema !== this.schema)) throw new Error('event schema mismatch'); }
      catch { message.term(); pending.delete(message); return; }
      const delivery: EventDelivery = {
        event,
        sequence: message.info.streamSequence,
        ack: () => { message.ack(); pending.delete(message); },
        retry: async (delayMs = 1000) => {
          const at = Date.now() + Math.min(Math.max(delayMs, 1), 24 * 60 * 60 * 1000);
          const transportId = `${event.id}.retry.${message.info.streamSequence}.${message.info.deliveryCount}`;
          try {
            await this.publishAt({ ...event, available_at: new Date(at).toISOString() }, at, transportId);
            message.ack(); pending.delete(message);
          } catch { message.nak(1000); pending.delete(message); }
        },
        progress: () => message.working(),
      };
      const work = Promise.resolve().then(() => handler(delivery)).catch(() => delivery.retry()).then(() => {}, () => {});
      active.add(work);
      void work.finally(() => active.delete(work));
    });
    let subscription;
    try { subscription = await this.client.subscribe(`${this.stream}.${filter}`, opts); }
    catch (error) {
      if (!options.durable || (error as { api_error?: { err_code?: number } }).api_error?.err_code !== 10148) throw error;
      // Another process created the same durable after our initial lookup. Bind without recreating it.
      opts.bind(`${this.stream}_${filter.startsWith('chat.') ? 'CHAT' : 'WORK'}`, options.durable);
      subscription = await this.client.subscribe(`${this.stream}.${filter}`, opts);
    }
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        stopped = true; subscription.unsubscribe();
        // Handlers have bounded execution deadlines; let their final ACK win before releasing unacked work.
        await Promise.allSettled([...active]);
        for (const message of pending) message.nak();
        pending.clear(); this.subscriptions.delete(stop);
        await this.connection?.flush();
      })();
      return stopping;
    };
    this.subscriptions.add(stop);
    return stop;
  }
  onReconnect(fn: () => void): () => void { this.reconnect.add(fn); return () => { this.reconnect.delete(fn); }; }
  async close(): Promise<void> { for (const stop of [...this.subscriptions]) await stop(); await this.connection?.close(); this.connection = undefined; this.client = undefined; }
}
