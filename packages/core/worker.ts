import { AppError, type AgentConnector } from '@space/contracts';
import type { DeliveryStore } from './ports.js';
export async function deliverOne(store: DeliveryStore, connectors: AgentConnector[], timeoutMs = 10_000, deliveryId?: string): Promise<boolean> {
  const delivery = await store.claimDelivery(undefined, deliveryId);
  if (!delivery) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let accepting = true;
  let invoked = false;
  try {
    const prepared = await store.prepareDelivery(delivery);
    if (!prepared) { await store.ackDelivery(delivery); return true; }
    if (delivery.attempts > 3) throw new AppError(403, 'delivery_exhausted');
    const connector = connectors.find(c => c.id === prepared.installation.connector_id);
    if (!connector) throw new AppError(403, 'connector_unavailable');
    const invoke = async () => {
      const capabilities = await connector.discover();
      controller.signal.throwIfAborted();
      if (!capabilities.skills.includes(prepared.request.skill)) throw new AppError(403, 'skill_unsupported');
      invoked = true;
      return connector.invoke(prepared.request, async event => {
        if (!accepting) throw new AppError(409, 'delivery_expired');
        await store.acceptEvent(prepared.installation.id, event, delivery);
      }, controller.signal);
    };
    await Promise.race([
      invoke(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { accepting = false; controller.abort(); reject(new AppError(504, 'connector_timeout')); }, timeoutMs); }),
    ]);
    if (!await store.executionTerminal(delivery.execution_id)) throw new AppError(502, 'missing_terminal_event');
    await store.ackDelivery(delivery);
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'connector_failed';
    // Do not store arbitrary connector errors; they may contain credentials or payloads.
    await store.failDelivery(delivery, invoked ? 'execution_uncertain' : code, invoked || error instanceof AppError && [403, 404].includes(error.status));
  } finally { accepting = false; controller.abort(); clearTimeout(timer); }
  return true;
}
