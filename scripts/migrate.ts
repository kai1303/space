import { fileURLToPath } from 'node:url';
import { createPool } from '@space/postgres/database';
import { migrate } from '@space/postgres/migrate';
import { importMemoryDocuments } from '@space/postgres/import-memory';

const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  const root = process.env.MEMORY_DIRECTORY ?? fileURLToPath(new URL('../../.space-memory/', import.meta.url));
  const count = await importMemoryDocuments(pool, root, !process.env.MEMORY_DIRECTORY);
  console.log(`Database migrated. Imported ${count} legacy memory documents.`);
} finally { await pool.end(); }
