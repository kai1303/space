import { createClient } from 'redis';

// Redis carries wake-up hints only. Authorized PostgreSQL history supplies content.
export class RedisChatSignals {
  private readonly publisher;
  private readonly subscriber;
  constructor(url: string | undefined, private topic = 'space:chat') {
    if (!url) throw new Error('REDIS_URL is required');
    this.publisher = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 3000 } });
    this.subscriber = this.publisher.duplicate();
    for (const client of [this.publisher, this.subscriber]) client.on('error', () => {});
  }
  async connect() { await this.publisher.connect(); }
  async listen(wake: () => void) {
    await this.subscriber.connect();
    await this.subscriber.subscribe(this.topic, () => wake());
  }
  async publish(): Promise<void> {
    // A missed hint is repaired by reconnect/periodic history reconciliation.
    if (!this.publisher.isReady) return;
    try { await this.publisher.withAbortSignal(AbortSignal.timeout(1000)).publish(this.topic, 'changed'); } catch { /* Database commit remains successful. */ }
  }
  close() {
    for (const client of [this.publisher, this.subscriber]) if (client.isOpen) client.destroy();
  }
}
