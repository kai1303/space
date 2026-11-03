import type { Socket } from 'socket.io';
import { AppError, parseAgentEvent, record } from '@space/contracts';
import type { Delivery } from '@space/core/ports';
import type { AgentConnectionStore } from '@space/postgres/agent-connections';
import type { PostgresStore } from '@space/postgres/store';

// Each socket owns one bounded lease; requests never choose an installation or lease.
export function registerLocalCodexTasks(socket: Socket, connections: AgentConnectionStore, tasks: PostgresStore) {
  const identity = socket.data.agent as { id: string; connection_id: string };
  let active: Delivery | undefined;
  let deadline = 0;
  let queue = Promise.resolve();
  let pending = 0, count = 0, windowStart = Date.now();
  const fail = async (code: string) => {
    if (active) await tasks.failDelivery(active, code, true);
    active = undefined;
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
      active = await tasks.claimDelivery(identity.id) ?? undefined;
      if (!active) return null;
      deadline = Date.now() + 180_000;
      if (active.attempts > 1) { await fail('local_execution_interrupted'); return null; }
      try {
        const prepared = await tasks.prepareDelivery(active, identity.connection_id);
        if (!prepared) { await tasks.ackDelivery(active); active = undefined; return null; }
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
      return true;
    },
    'agent.task.fail': async (raw: unknown) => { record(raw, []); current(); await fail('local_execution_failed'); return true; },
  };
  for (const [name, handle] of Object.entries(commands)) socket.on(name, (raw: unknown, ack: unknown) => {
    if (typeof ack !== 'function') return;
    if (Date.now() - windowStart >= 1000) { count = 0; windowStart = Date.now(); }
    if (++count > 40 || pending >= 40) { ack({ error: 'busy' }); return; }
    pending++;
    queue = queue.then(async () => {
      try {
        if (!socket.connected) throw new AppError(401, 'unauthorized');
        await connections.authenticateConnection(socket.data.token, identity.connection_id);
        ack({ data: await handle(raw) });
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'internal_error';
        ack({ error: code });
        if (['unauthorized', 'agent_not_ready', 'connector_timeout'].includes(code)) {
          await fail(code);
          if (code === 'unauthorized') socket.disconnect(true);
        }
      } finally { pending--; }
    }).catch(() => { socket.disconnect(true); });
  });
  socket.on('disconnect', () => { queue = queue.then(() => fail('local_execution_interrupted')).catch(() => {}); });
}
