import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

export class RedisSocketAdapter {
  private readonly publisher;
  private readonly subscriber;
  readonly adapter;
  constructor(url: string | undefined, key = 'space:socket.io') {
    if (!url) throw new Error('REDIS_URL is required');
    this.publisher = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 3000 } });
    this.subscriber = this.publisher.duplicate();
    for (const client of [this.publisher, this.subscriber]) {
      client.on('error', () => {});
      // The adapter ignores these promises. Observe rejections without changing awaited errors.
      for (const name of ['publish', 'pSubscribe', 'subscribe', 'pUnsubscribe', 'unsubscribe'] as const) {
        const execute = client[name];
        Reflect.set(client, name, (...args: unknown[]) => {
          const pending = Reflect.apply(execute, client, args);
          void pending.catch(() => {});
          return pending;
        });
      }
    }
    this.adapter = createAdapter(this.publisher, this.subscriber, { key, requestsTimeout: 2000, publishOnSpecificResponseChannel: true });
  }
  async connect() {
    try { await Promise.all([this.publisher.connect(), this.subscriber.connect()]); }
    catch (error) { await this.close(); throw error; }
  }
  get isReady() { return this.publisher.isReady && this.subscriber.isReady; }
  onReady(listener: () => void): () => void {
    const ready = () => { if (this.isReady) listener(); };
    this.publisher.on('ready', ready); this.subscriber.on('ready', ready);
    ready();
    return () => { this.publisher.off('ready', ready); this.subscriber.off('ready', ready); };
  }
  async close() {
    await Promise.all([this.publisher, this.subscriber].map(async client => {
      if (!client.isOpen) return;
      if (!client.isReady) { client.destroy(); return; }
      await client.quit();
    }));
  }
}
