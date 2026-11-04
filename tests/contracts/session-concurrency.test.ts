import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '@space/contracts';
import type { Database } from '@space/postgres/database';
import { sessionTransaction, SessionConflict } from '../../adapters/postgres/dist/session-concurrency.js';

test('transaction conflicts yield so competing work can finish before retrying', async () => {
  let competing = true, attempts = 0;
  const finished = setImmediate(() => { competing = false; });
  const db = { async transaction(work: () => Promise<string>) {
    attempts++;
    if (competing) throw { cause: { code: '40001' } };
    return work();
  } } as unknown as Database;
  try {
    assert.equal(await sessionTransaction(db, async () => 'committed'), 'committed');
    assert.ok(attempts > 1);
  } finally { clearImmediate(finished); }
});

test('persistent transaction conflicts exhaust a bounded retry budget', async () => {
  let attempts = 0;
  const db = { async transaction() { attempts++; throw new SessionConflict(); } } as unknown as Database;
  await assert.rejects(sessionTransaction(db, async () => undefined), { status: 409, code: 'session_conflict' });
  assert.equal(attempts, 5);
});

test('business errors are returned immediately without retrying', async () => {
  let attempts = 0;
  const error = new AppError(409, 'session_busy');
  const db = { async transaction() { attempts++; throw error; } } as unknown as Database;
  await assert.rejects(sessionTransaction(db, async () => undefined), value => value === error);
  assert.equal(attempts, 1);
});
