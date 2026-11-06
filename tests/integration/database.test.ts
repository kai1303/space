import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { database } from '@space/postgres/database';
import { users, agentDefinitions } from '@space/postgres/schema';
import { migrate, migrationFiles } from '@space/postgres/migrate';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
test('Drizzle rolls back on failure, reuses the pool, binds text and preserves migrated data', async () => {
  const schema = `drizzle_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    const db = database(pool);
    const id = randomUUID();
    await assert.rejects(db.transaction(async tx => {
      await tx.insert(users).values({ id });
      throw new Error('deliberate rollback');
    }), /deliberate rollback/);
    assert.equal((await db.select().from(users)).length, 0);
    await db.insert(users).values({ id });
    const name = "Agent'); DROP TABLE users; --";
    await db.insert(agentDefinitions).values({ id: randomUUID(), name, capabilities: { skills: ['echo'], controls: {} } });
    await migrate(pool);
    assert.equal((await db.select().from(users))[0]?.id, id);
    assert.equal((await db.select().from(agentDefinitions))[0]?.name, name);
    assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, migrationFiles.length);
    // Independently merged migrations can leave gaps; their filenames retain their identity.
    assert.deepEqual(
      (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version),
      migrationFiles.map(file => Number(file.split('_')[0])).sort((a, b) => a - b),
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
