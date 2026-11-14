import { AppError, record, text } from './validation.js';

export type GoalAction = { kind: 'set'; objective: string } | { kind: 'pause' | 'resume' | 'clear' };
export const goalLabels = {
  active: 'Pursuing goal', paused: 'Paused goal', complete: 'Goal achieved', blocked: 'Goal stalled',
  usageLimited: 'Goal usage limited', budgetLimited: 'Goal budget reached', ended: 'Goal ended',
} as const;
export interface SessionGoal { objective: string; status: keyof typeof goalLabels; reason?: string }

export function parseGoalAction(raw: unknown): GoalAction {
  const { kind, objective } = record(raw, ['kind', 'objective']);
  if (kind === 'set') return { kind, objective: text(objective, 4000).trim() };
  if (objective === undefined && (kind === 'pause' || kind === 'resume' || kind === 'clear')) return { kind };
  throw new AppError(400, 'invalid_goal_action');
}

export function parseSessionGoal(raw: unknown): SessionGoal | null {
  if (raw === null) return null;
  const { objective, status, reason } = record(raw, ['objective', 'status', 'reason']);
  if (typeof status !== 'string' || !Object.hasOwn(goalLabels, status)) throw new AppError(400, 'invalid_goal_status');
  return { objective: text(objective), status: status as SessionGoal['status'], ...(reason ? {reason: text(reason, 4000)} : {}) };
}
