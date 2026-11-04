import { AppError } from '@space/contracts';

type Job = { run: () => Promise<unknown>; resolve: (value: any) => void; reject: (error: unknown) => void };

// One process-wide budget; rotate owners so one socket cannot monopolize queued reads.
export class RealtimeWork {
  private readonly owners = new Map<string, Job[]>();
  private active = 0;
  private queued = 0;
  private rejected = 0;
  constructor(readonly concurrency = 4, readonly capacity = 512) {
    if (![concurrency, capacity].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('invalid realtime work limits');
  }
  run<T>(owner: string, run: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency && this.queued >= this.capacity) {
      this.rejected++; return Promise.reject(new AppError(503, 'realtime_overloaded'));
    }
    return new Promise<T>((resolve, reject) => {
      const queue = this.owners.get(owner) ?? [];
      queue.push({run, resolve, reject}); this.owners.set(owner, queue); this.queued++;
      this.drain();
    });
  }
  cancel(owner: string) {
    const queue = this.owners.get(owner);
    if (!queue) return;
    this.owners.delete(owner); this.queued -= queue.length;
    for (const job of queue) job.reject(new AppError(499, 'connection_closed'));
  }
  stats() { return { active: this.active, queued: this.queued, rejected: this.rejected, concurrency: this.concurrency, capacity: this.capacity }; }
  private drain() {
    while (this.active < this.concurrency && this.owners.size) {
      const [owner, queue] = this.owners.entries().next().value!;
      const job = queue.shift()!;
      this.owners.delete(owner); if (queue.length) this.owners.set(owner, queue);
      this.queued--; this.active++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { this.active--; this.drain(); });
    }
  }
}

export class SubscriptionIndex {
  private readonly keys = new Map<string, Set<() => void>>();
  private readonly all = new Set<() => void>();
  add(keys: readonly string[], wake: () => void): () => void {
    this.all.add(wake);
    for (const key of keys) { const listeners = this.keys.get(key) ?? new Set(); listeners.add(wake); this.keys.set(key, listeners); }
    return () => {
      this.all.delete(wake);
      for (const key of keys) { const listeners = this.keys.get(key); listeners?.delete(wake); if (!listeners?.size) this.keys.delete(key); }
    };
  }
  wake(keys?: readonly string[]) {
    const listeners = keys ? new Set(keys.flatMap(key => [...this.keys.get(key) ?? []])) : this.all;
    for (const wake of listeners) wake();
  }
}
