import { AppError } from '@space/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import type { Database, DbSession } from './database.js';
import { commitWithTurnTrace } from './turn-trace.js';
export class SessionConflict extends Error {}
export async function sessionTransaction<T>(db: Database, work: (c: DbSession) => Promise<T>, isolationLevel: 'serializable' | 'read committed' = 'serializable', retryDelayMs = 20): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await commitWithTurnTrace(db, work, isolationLevel); }
    catch (error) {
      const failure = error as { code?: string; cause?: { code?: string } };
      const code = failure.cause?.code ?? failure.code;
      if (!(error instanceof SessionConflict) && !['40001', '40P01', '23505'].includes(code ?? '')) throw error;
      if (attempt === 4) throw new AppError(409, 'session_conflict');
      // Let competing commits settle; jitter spreads simultaneous retries.
      await delay(retryDelayMs * 2 ** attempt * (1 + Math.random()));
    }
  }
  throw new AppError(409, 'session_conflict');
}
