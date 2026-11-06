import type { EventBus, EventDelivery } from '@space/events';
import type { Socket } from 'socket.io';
import { AppError, parseAgentEvent, record } from '@space/contracts';
import type { Delivery } from '@space/core/ports';
import type { AgentConnectionStore } from '@space/postgres/agent-connections';
import type { PostgresStore } from '@space/postgres/store';
import type { RealtimeWork } from './realtime-work.js';

// Broker delivery owns work; connector commands never choose an installation or attempt.
export function registerLocalCodexTasks(socket: Socket, connections: AgentConnectionStore, tasks: PostgresStore, getEvents: () => Promise<EventBus>, work: RealtimeWork, independent = false) {
  const identity = socket.data.agent as { id: string; connection_id: string };
  let active: Delivery | undefined;
  let offered: EventDelivery | undefined, receipt: EventDelivery | undefined;
  let releaseReceipt: (() => void) | undefined;
  let stopped = false;
  const settle = async (retry = false) => {
    const current = receipt ?? offered;
    receipt = undefined; offered = undefined;
    try { if (current) { if (retry) await current.retry(); else await current.ack(); } }
    finally { releaseReceipt?.(); releaseReceipt = undefined; }
  };
  const subscription = getEvents().then(bus => bus.subscribe(`task.local.ready.${identity.id}`, {
    durable:`local-${identity.id}`, queue:`local-${identity.id}`, maxPending:1,
  }, async message => {
    if (stopped || !socket.connected) { await message.retry(); return; }
    const due = Date.parse(message.event.available_at ?? '');
    if (Number.isFinite(due) && due > Date.now()) { await message.retry(due-Date.now()); return; }
    if (offered || receipt) { await message.retry(); return; }
    offered = message;
    const finished = new Promise<void>(resolve => { releaseReceipt = resolve; });
    socket.emit('agent.tasks.available');
    await finished;
  })).catch(() => { if (!independent && socket.connected) socket.disconnect(true); return undefined; });
  let deadline = 0;
  let queue = Promise.resolve();
  let pending = 0, count = 0, windowStart = Date.now();
  const fail = async (code: string) => {
    if (active) await tasks.failDelivery(active, code, true);
    active = undefined;
    await settle();
  };
  const current = () => {
    if (!active) throw new AppError(409, 'no_active_execution');
    if (Date.now() > deadline) throw new AppError(504, 'connector_timeout');
    return active;
  };
  const commands = {
    'agent.task.claim': async (raw: unknown) => {
      record(raw, []);
      if (active) throw new AppError(409, 'agent_busy');
      if (!offered) return null;
      receipt = offered; offered = undefined;
      active = await tasks.claimDelivery(identity.id, String(receipt.event.data.delivery_id)) ?? undefined;
      if (!active) { await settle(); return null; }
      deadline = Date.now() + 180_000;
      if (active.attempts > 1) { await fail('local_execution_interrupted'); return null; }
      try {
        const prepared = await tasks.prepareDelivery(active, identity.connection_id);
        if (!prepared) { await tasks.ackDelivery(active); active = undefined; await settle(); return null; }
        return prepared.request;
      } catch (error) { await fail('local_execution_unavailable'); throw error; }
    },
    'agent.task.event': async (raw: unknown) => {
      const input = record(raw, ['event']);
      const delivery = current();
      // Bound structured snapshots before parsing and storing them.
      if (JSON.stringify(input.event).length > 80_000) throw new AppError(400, 'agent_event_too_large');
      const event = parseAgentEvent(input.event);
      if (event.execution_id !== delivery.execution_id) throw new AppError(409, 'stale_execution');
      await tasks.acceptEvent(identity.id, event, delivery, identity.connection_id);
      return true;
    },
    'agent.task.renew': async (raw: unknown) => {
      record(raw, []);
      if (!await tasks.renewDelivery(current(), identity.connection_id)) throw new AppError(409, 'stale_lease');
      return true;
    },
    'agent.task.finish': async (raw: unknown) => {
      record(raw, []);
      const delivery = current();
      if (!await tasks.executionTerminal(delivery.execution_id)) throw new AppError(409, 'missing_terminal_event');
      if (!await tasks.ackDelivery(delivery)) throw new AppError(409, 'stale_lease');
      active = undefined;
      await settle();
      return true;
    },
    'agent.task.fail': async (raw: unknown) => { record(raw, []); current(); await fail('local_execution_failed'); return true; },
  };
  for (const [name, handle] of Object.entries(commands)) socket.on(name, (raw: unknown, ack: unknown) => {
    if (typeof ack !== 'function') return;
    if (Date.now() - windowStart >= 1000) { count = 0; windowStart = Date.now(); }
    if (++count > 40 || pending >= 40) { ack({ error: 'busy' }); return; }
    pending++;
    queue = queue.then(() => work.run(socket.id, async () => {
      try {
        if (!socket.connected) throw new AppError(401, 'unauthorized');
        await connections.authenticateConnection(socket.data.token, identity.connection_id);
        const data = await handle(raw);
        ack({ data });
      } catch (error) {
        let code = error instanceof AppError ? error.code : 'internal_error';
        if (name === 'agent.task.claim' && receipt && !active) await settle(true);
        const incoming = raw as { event?: { execution_id?: unknown } } | null;
        const matchesExecution = name !== 'agent.task.event' || incoming?.event?.execution_id === active?.execution_id;
        if (active && matchesExecution && ['agent.task.event', 'agent.task.renew', 'agent.task.finish'].includes(name) && ['stale_execution', 'stale_lease', 'session_ended'].includes(code)) {
          try {
            if (await tasks.wasSessionStopped(active, identity.id, identity.connection_id)) {
              active = undefined;
              await settle();
              code = 'agent_session_stopped';
            }
          } catch (failure) { code = failure instanceof AppError ? failure.code : 'internal_error'; }
        }
        ack({ error: code });
        if (['unauthorized', 'agent_not_ready', 'connector_timeout'].includes(code)) {
          await fail(code);
          if (code === 'unauthorized') socket.disconnect(true);
        }
      }
    })).catch(error => {
      ack({error:error instanceof AppError ? error.code : 'internal_error'});
      socket.disconnect(true);
    }).finally(() => { pending--; });
  });
  socket.on('disconnect', () => {
    stopped = true;
    queue = queue.then(() => work.run(`cleanup:${socket.id}`, async () => {
      if (active) await fail('local_execution_interrupted'); else await settle(true);
    })).catch(() => settle(true)); // If admission fails, broker redelivery and the durable deadline retain recovery.
    void queue.finally(async () => { const stop = await subscription; await stop?.(); });
  });
  return { ready: independent ? Promise.resolve() : subscription.then(() => {}), notifyReady: () => { if (offered && socket.connected) socket.emit('agent.tasks.available'); } };
}
