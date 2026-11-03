import { AppError, type AgentInstallation, type Task } from '@space/contracts';
export function assertEligible(installation: AgentInstallation, skill: string, hasGrant: boolean, requesterHasAccess: boolean, ownerHasAccess: boolean): void {
  if (!installation.enabled || !installation.capabilities.skills.includes(skill) || !hasGrant || !requesterHasAccess || !ownerHasAccess) throw new AppError(403, 'installation_not_authorized');
}
export function assertApprover(actor: string, task: Task, installation: AgentInstallation): void {
  if (actor !== installation.owner_id) throw new AppError(403, 'approval_not_authorized');
  if (task.status !== 'awaiting_approval' && task.status !== 'queued') throw new AppError(409, 'invalid_transition');
}
