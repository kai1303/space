import { createPool } from '@space/postgres/database';
import { initializeWorkspaceOwner } from '@space/postgres/provisioning';
import { uuid } from '@space/contracts';

const workspace = uuid(process.env.WORKSPACE_ID), owner = uuid(process.env.OWNER_USER_ID);
const pool = createPool(process.env.DATABASE_URL);
try {
  await initializeWorkspaceOwner(pool, workspace, owner);
  console.log('Initial workspace owner assigned.');
} catch {
  console.error('Owner initialization failed. Select an active member of a workspace with no owner.');
  process.exitCode = 1;
} finally { await pool.end(); }
