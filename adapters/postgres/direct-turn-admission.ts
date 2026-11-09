import { eq } from 'drizzle-orm';
import { AppError, type Task } from '@space/contracts';
import type { Database, DbSession } from './database.js';
import { agentConnections } from './schema.js';
import { sessionTransaction } from './session-concurrency.js';

type Session = { id: string; managed: boolean; revision: number };
export type AdmissionTarget = { connection: string; session: string; sessionRevision: number; taskRevision?: number };
export type TurnPlan = { existing: Task } | { target?: AdmissionTarget; commit(): Promise<Task> };
export type AdmitLocalTurn = (connection: string, session: string) => Promise<void>;

export async function directTurnTarget(c: DbSession, installation: {id:string; connector_id:string}, session?: Session, taskRevision?: number): Promise<AdmissionTarget | undefined> {
  if (!session?.managed || installation.connector_id !== 'codex.local') return;
  const [agent] = await c.select().from(agentConnections).where(eq(agentConnections.installation_id, installation.id));
  if (!agent?.connection_id || agent.auth_status !== 'ready' || !agent.last_seen_at || Date.now() - agent.last_seen_at.getTime() > 45_000)
    throw new AppError(409, 'agent_unavailable');
  return { connection:agent.connection_id, session:session.id, sessionRevision:session.revision, taskRevision };
}

// Queued turns commit on the first pass. Direct turns release their database client
// for socket admission, then repeat authorization and compare the exact target.
export async function runTurn(db: Database, prepare: (c: DbSession) => Promise<TurnPlan>, admit?: AdmitLocalTurn): Promise<Task> {
  const first = await sessionTransaction(db, async c => {
    const plan = await prepare(c);
    if ('existing' in plan) return plan.existing;
    const target = plan.target;
    if (target && admit) return {target, admit};
    return plan.commit();
  });
  if (!('target' in first)) return first;

  const checked = first.target;
  await first.admit(checked.connection, checked.session);
  return sessionTransaction(db, async c => {
    const plan = await prepare(c);
    if ('existing' in plan) return plan.existing;
    const target = plan.target;
    if (target?.connection !== checked.connection) throw new AppError(409, 'agent_unavailable');
    if (target.session !== checked.session || target.sessionRevision !== checked.sessionRevision || target.taskRevision !== checked.taskRevision)
      throw new AppError(409, 'session_conflict');
    return plan.commit();
  });
}
