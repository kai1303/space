import type { AgentInstallation, InvocationRequest } from '@space/contracts';
// lease_token is the persisted attempt fence; expiry never permits another invocation.
export interface Delivery { id: string; task_id: string; execution_id: string; lease_token: string; attempts: number }
export interface PreparedDelivery { installation: AgentInstallation; request: InvocationRequest }
export interface DeliveryStore {
  claimDelivery(localInstallation?: string, deliveryId?: string): Promise<Delivery | null>;
  prepareDelivery(delivery: Delivery): Promise<PreparedDelivery | null>;
  acceptEvent(installationId: string, event: unknown, delivery?: Delivery): Promise<void>;
  ackDelivery(delivery: Delivery): Promise<boolean>;
  failDelivery(delivery: Delivery, code: string, permanent?: boolean): Promise<void>;
  executionTerminal(executionId: string): Promise<boolean>;
}
