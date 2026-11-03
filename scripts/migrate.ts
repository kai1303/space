import { createPool } from '@space/postgres/database';
import { migrate } from '@space/postgres/migrate';
const pool = createPool(process.env.DATABASE_URL);
try { await migrate(pool); console.log('Database migrated'); }
finally { await pool.end(); }
