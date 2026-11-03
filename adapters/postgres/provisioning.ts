import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import { AppError, parseProfileInput, uuid } from '@space/contracts';
import { database, type DbSession } from './database.js';
import { tokenHash } from './bootstrap.js';
import { users, humanCredentials, workspaces, workspaceMembers as m, workspaceEvents } from './schema.js';

// Trusted operator only. The caller owns the transaction, including saving the
// returned development credential. Never expose this through a public route.
export async function provisionUser(tx: DbSession, input: unknown) {
  const profile = parseProfileInput(input);
  const id = randomUUID(), token = randomBytes(32).toString('hex');
  await tx.insert(users).values({ id, ...profile });
  await tx.insert(humanCredentials).values({ user_id: id, token_hash: tokenHash(token) });
  return { id, ...profile, token };
}

// Legacy migrations cannot infer workspace authority from agent ownership.
// An operator explicitly appoints one existing active member, once per workspace.
export async function initializeWorkspaceOwner(pool: Pool, workspace: string, user: string): Promise<void> {
  workspace = uuid(workspace);
  user = uuid(user);
  await database(pool).transaction(async tx => {
    if (!(await tx.select().from(workspaces).where(eq(workspaces.id, workspace)).for('update')).length) throw new AppError(404, 'not_found');
    const owners = await tx.select().from(m).where(and(eq(m.workspace_id, workspace), eq(m.active, true), eq(m.role, 'owner')));
    if (owners.length) {
      if (owners.length === 1 && owners[0]!.user_id === user) return;
      throw new AppError(409, 'owner_already_initialized');
    }
    const [member] = await tx.update(m).set({ role: 'owner' })
      .where(and(eq(m.workspace_id, workspace), eq(m.user_id, user), eq(m.active, true))).returning();
    if (!member) throw new AppError(404, 'not_found');
    await tx.insert(workspaceEvents).values({
      id: randomUUID(), workspace_id: workspace, actor_id: user, type: 'workspace.owner_initialized',
      payload: { user_id: user, source: 'trusted_operator' },
    });
  });
}

