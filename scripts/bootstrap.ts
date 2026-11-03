import { writeFile } from 'node:fs/promises';
import { createPool } from '@space/postgres/database';
import { bootstrap } from '@space/postgres/bootstrap';
const path = process.env.DEMO_ENV_FILE ?? '.env.demo';
const pool = createPool(process.env.DATABASE_URL);
try {
  const seed = await bootstrap(pool);
  await writeFile(path, Object.entries(seed).map(([key, value]) => `${key.toUpperCase()}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Demo workspace created. Credentials saved to ${path}; keep this file private.`);
} finally { await pool.end(); }
