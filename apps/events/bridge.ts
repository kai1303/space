import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Pool } from 'pg';
import { LogicalReplicationService, PgoutputPlugin, type Pgoutput } from 'pg-logical-replication';
import { EventBus, streamName, type DomainEvent } from '@space/events';

type Options = { databaseUrl: string; natsUrl: string; schema?: string; maxTransactionBytes?: number; onError?: (error: unknown) => void };
export class EventBridge {
  private readonly pool: Pool;
  private readonly bus: EventBus;
  private replication?: LogicalReplicationService;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private running?: Promise<void>;
  private directory?: string;
  private spool?: FileHandle;
  private bytes = 0;
  private checkpoint = '0/0';
  private handling: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  readonly schema: string;
  readonly slot: string;
  readonly publication: string;
  constructor(private readonly options: Options) {
    this.schema = options.schema ?? '*';
    if (this.schema !== '*' && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.schema)) throw new Error('invalid CDC schema');
    const scope = streamName(this.schema).toLowerCase();
    this.slot = `${scope}_cdc`; this.publication = `${scope}_publication`;
    this.pool = new Pool({ connectionString: options.databaseUrl, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
    this.pool.on('error', error => this.options.onError?.(error));
    this.bus = new EventBus(options.natsUrl, this.schema);
  }
  async start(): Promise<void> {
    try {
      await this.bus.start();
      this.directory = await mkdtemp(join(tmpdir(), 'space-cdc-'));
      await this.prepare();
      await this.bootstrap();
      await this.connect();
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }
  private async prepare(): Promise<void> {
    const { rows } = await this.pool.query('SELECT 1 FROM pg_publication WHERE pubname=$1', [this.publication]);
    if (!rows.length) {
      try { await this.pool.query(`CREATE PUBLICATION "${this.publication}" ${this.schema === '*' ? 'FOR ALL TABLES' : `FOR TABLE "${this.schema}".event_outbox`} WITH (publish='insert')`); }
      catch (error) { if ((error as { code?: string }).code !== '42710') throw error; }
    }
    const slot = await this.pool.query('SELECT 1 FROM pg_replication_slots WHERE slot_name=$1', [this.slot]);
    if (!slot.rows.length) {
      try { await this.pool.query("SELECT pg_create_logical_replication_slot($1,'pgoutput')", [this.slot]); }
      catch (error) { if ((error as { code?: string }).code !== '42710') throw error; }
    }
    const position = await this.pool.query('SELECT confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name=$1', [this.slot]);
    this.checkpoint = position.rows[0].confirmed_flush_lsn;
  }
  private event(row: Record<string, any>, schema = this.schema): DomainEvent {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('invalid CDC source schema');
    return { id: row.id, schema, kind: row.kind, aggregate_id: row.aggregate_id, data: row.payload, ...(row.available_at ? { available_at: new Date(row.available_at).toISOString() } : {}) };
  }
  private async publish(event: DomainEvent): Promise<void> {
    await this.bus.publish(event);
    // Broker ACK is the durability boundary. Keyed cleanup can safely repeat after a crash.
    try { await this.pool.query(`DELETE FROM "${event.schema}".event_outbox WHERE id=$1`, [event.id]); }
    catch (error) { if ((error as { code?: string }).code !== '42P01') throw error; }
    if (event.kind === 'chat.changed' && typeof event.data.chat_delivery_id === 'string') {
      try { await this.pool.query(`DELETE FROM "${event.schema}".chat_delivery_outbox WHERE id=$1`, [event.data.chat_delivery_id]); }
      catch (error) { if ((error as { code?: string }).code !== '42P01') throw error; }
    }
  }
  private async publishBatch(events: DomainEvent[]): Promise<void> {
    const outcomes = await Promise.allSettled(events.map(event => this.publish(event)));
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  private async bootstrap(): Promise<void> {
    // The slot exists before this finite snapshot, so writes racing the snapshot are in WAL.
    const schemas = this.schema === '*' ? (await this.pool.query("SELECT table_schema FROM information_schema.tables WHERE table_name='event_outbox' AND table_schema !~ '^pg_'")).rows.map(row => row.table_schema as string) : [this.schema];
    for (const schema of schemas) await this.bootstrapSchema(schema);
  }
  private async bootstrapSchema(schema: string): Promise<void> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('invalid CDC source schema');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`DECLARE initial_events NO SCROLL CURSOR FOR SELECT * FROM "${schema}".event_outbox ORDER BY created_at,id`);
      for (;;) {
        const batch = await client.query('FETCH 100 FROM initial_events');
        for (let offset = 0; offset < batch.rows.length; offset += 16) await this.publishBatch(batch.rows.slice(offset, offset + 16).map(row => this.event(row, schema)));
        if (batch.rows.length < 100) break;
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); if ((error as { code?: string }).code !== '42P01') throw error; }
    finally { client.release(); }
  }
  private async message(message: Pgoutput.Message): Promise<void> {
    if (message.tag === 'begin') {
      await this.spool?.close(); this.spool = undefined; this.bytes = 0;
    } else if (message.tag === 'insert' && (this.schema === '*' || message.relation.schema === this.schema) && message.relation.name === 'event_outbox') {
      const line = JSON.stringify(this.event(message.new, message.relation.schema)) + '\n';
      this.bytes += Buffer.byteLength(line);
      if (this.bytes > (this.options.maxTransactionBytes ?? 1024 ** 3)) throw new Error('CDC transaction exceeds bounded spool capacity');
      this.spool ??= await open(join(this.directory!, 'transaction.ndjson'), 'w', 0o600);
      await this.spool.write(line);
    } else if (message.tag === 'commit') {
      if (this.spool) {
        await this.spool.close(); this.spool = undefined;
        const lines = createInterface({ input: createReadStream(join(this.directory!, 'transaction.ndjson')), crlfDelay: Infinity });
        let batch: DomainEvent[] = [];
        for await (const line of lines) {
          batch.push(JSON.parse(line));
          if (batch.length === 16) { await this.publishBatch(batch); batch = []; }
        }
        if (batch.length) await this.publishBatch(batch);
      }
      if (message.commitEndLsn) { this.checkpoint = message.commitEndLsn; await this.replication!.acknowledge(this.checkpoint); }
    }
  }
  private async connect(): Promise<void> {
    if (this.stopped) return;
    const replication = this.replication = new LogicalReplicationService({ connectionString: this.options.databaseUrl, application_name: `space-cdc-${this.schema}`, keepAlive: true }, { acknowledge: { auto: false, timeoutSeconds: 0 }, flowControl: { enabled: true } });
    // The library standby timer acknowledges received WAL, so only our committed checkpoint answers keepalives.
    replication.on('heartbeat', async (_lsn, _time, respond) => { if (respond) await replication.acknowledge(this.checkpoint); });
    let failed = false;
    replication.on('data', async (_lsn, message: Pgoutput.Message) => {
      if (failed || this.stopped) return;
      this.handling = this.message(message);
      try { await this.handling; } catch (error) { failed = true; throw error; }
    });
    let fail!: (error: unknown) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    replication.on('error', error => { failed = true; fail(error); });
    const ready = new Promise<void>((resolve, reject) => { replication.once('start', resolve); replication.once('error', reject); });
    this.running = Promise.race([replication.subscribe(new PgoutputPlugin({ protoVersion: 1, publicationNames: [this.publication] }), this.slot), failure]).then(() => {
      if (!this.stopped) throw new Error('CDC replication connection ended');
    }).catch(async error => {
      failed = true; await replication.stop(); await this.handling.catch(() => {});
      if (this.stopped) return;
      this.options.onError?.(error);
      this.retry = setTimeout(() => { void this.connect().catch(error => this.options.onError?.(error)); }, 1000);
    });
    await ready;
  }
  close(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.retry);
    await this.replication?.stop(); await this.running; await this.handling.catch(() => {});
    await this.spool?.close(); this.spool = undefined;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    await this.bus.close(); await this.pool.end();
  }
}
