import { randomUUID } from 'node:crypto';
import type { ChatEvent } from '@space/contracts';
import type { Server, Socket } from 'socket.io';

export const receiptOutcomes = ['confirmed', 'timeout', 'disconnected', 'capacity', 'send_failed', 'duplicate', 'invalid_report'] as const;
type Outcome = typeof receiptOutcomes[number];
export interface ReceiptMetrics {
  outcome(value: Outcome): void;
  duration(seconds: number): void;
}
const deadlineMs = 15_000;
const maxSamples = 1024;
const maxSocketSamples = 8;

// Peer hints are transient. Only an authorized database-backed chat.events delivery can fulfill a watch.
export function liveReceipts(io: Server, metrics: ReceiptMetrics, peersReady: () => boolean) {
  const watched = new Map<string, number>();
  const pending = new Map<string, () => void>();
  io.on('space.receipt.watch', (id: string) => {
    if (watched.size >= maxSamples) watched.delete(watched.keys().next().value!);
    watched.set(id, performance.now() + deadlineMs);
  });
  io.on('space.receipt.seen', (id: string) => pending.get(id)?.());
  return {
    candidates(events: ChatEvent[], actor: string, liveAfter: bigint) {
      const now = performance.now();
      return events.flatMap(event => {
        if (event.type !== 'message.created' || event.payload.author.kind !== 'human' ||
          event.payload.author.id === actor || BigInt(event.sequence) <= liveAfter) return [];
        const id = event.payload.id;
        return pending.has(id) || (watched.get(id) ?? 0) > now ? [id] : [];
      });
    },
    received(ids: string[]) {
      for (const id of ids) {
        const local = pending.get(id);
        if (local) local();
        else if (watched.delete(id) && peersReady()) io.serverSideEmit('space.receipt.seen', id);
      }
    },
    sender(socket: Socket) {
      const active = new Set<(outcome: Outcome) => void>();
      socket.once('disconnect', () => { for (const finish of active) finish('disconnected'); });
      return (clientId: string) => {
        if (pending.size >= maxSamples || active.size >= maxSocketSamples) {
          metrics.outcome('capacity'); return;
        }
        const id = randomUUID(), expires = performance.now() + deadlineMs;
        const finish = (outcome: Outcome) => {
          if (!active.delete(finish)) return;
          clearTimeout(timer); pending.delete(id); metrics.outcome(outcome);
        };
        const timer = setTimeout(() => finish('timeout'), deadlineMs);
        timer.unref();
        active.add(finish);
        let sent = false;
        pending.set(id, () => {
          if (sent) return;
          const remaining = Math.ceil(expires - performance.now());
          if (remaining <= 0) { finish('timeout'); return; }
          sent = true;
          // Only this socket's reply to this specific confirmation can report a duration.
          socket.timeout(remaining).emit('chat.receipt.confirmed', clientId, (error: Error | null, ms: unknown) => {
            if (!active.has(finish)) return;
            if (error) { finish(socket.connected ? 'timeout' : 'disconnected'); return; }
            if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > deadlineMs) {
              finish('invalid_report'); return;
            }
            metrics.duration(ms / 1000); finish('confirmed');
          });
        });
        if (peersReady()) io.serverSideEmit('space.receipt.watch', id);
        return { id, finish };
      };
    },
  };
}
