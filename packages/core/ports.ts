import type { AgentInstallation, InvocationRequest } from '@space/contracts';
export interface Delivery { id: string; task_id: string; execution_id: string; lease_token: string; attempts: number }
export interface PreparedDelivery { installation: AgentInstallation; request: InvocationRequest }
export interface DeliveryStore {
  claimDelivery(): Promise<Delivery | null>;
  prepareDelivery(delivery: Delivery): Promise<PreparedDelivery | null>;
  acceptEvent(installationId: string, event: unknown): Promise<void>;
  ackDelivery(delivery: Delivery): Promise<boolean>;
  failDelivery(delivery: Delivery, code: string, permanent?: boolean): Promise<void>;
  executionTerminal(executionId: string): Promise<boolean>;
}
