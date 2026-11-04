import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export function createPool(connectionString: string | undefined): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, statement_timeout: 10000, max: 10 });
  // pg emits idle-connection errors outside queries. Avoid crashing or logging secrets.
  pool.on('error', () => console.error('database_connection_error'));
  return pool;
}
export function database(client: Pool | PoolClient) { return drizzle({ client, schema }); }
export type Database = ReturnType<typeof database>;
export type DbSession = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
