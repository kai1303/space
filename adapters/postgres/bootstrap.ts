import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { database } from './database.js';
import * as s from './schema.js';
export function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export async function bootstrap(pool: Pool) {
  const seed = { workspace_id: randomUUID(), channel_id: randomUUID(), thread_id: randomUUID(), owner_id: randomUUID(), collaborator_id: randomUUID(), definition_id: randomUUID(), installation_id: randomUUID(), owner_token: randomBytes(32).toString('hex'), collaborator_token: randomBytes(32).toString('hex') };
  await database(pool).transaction(async c => {
    await c.insert(s.users).values([{ id: seed.owner_id, display_name: 'Demo owner' }, { id: seed.collaborator_id, display_name: 'Demo collaborator' }]);
    await c.insert(s.workspaces).values({ id: seed.workspace_id, name: 'General' });
    await c.insert(s.workspaceMembers).values([
      { workspace_id: seed.workspace_id, user_id: seed.owner_id, role: 'owner' },
      { workspace_id: seed.workspace_id, user_id: seed.collaborator_id, role: 'member' },
    ]);
    await c.insert(s.channels).values({ id: seed.channel_id, workspace_id: seed.workspace_id, name: 'general', private: false, created_by: seed.owner_id });
    await c.insert(s.channelMembers).values([seed.owner_id, seed.collaborator_id].map(user_id => ({ workspace_id: seed.workspace_id, channel_id: seed.channel_id, user_id })));
    await c.insert(s.threads).values({ id: seed.thread_id, workspace_id: seed.workspace_id, channel_id: seed.channel_id });
    await c.insert(s.humanCredentials).values([{ token_hash: tokenHash(seed.owner_token), user_id: seed.owner_id }, { token_hash: tokenHash(seed.collaborator_token), user_id: seed.collaborator_id }]);
    await c.insert(s.agentDefinitions).values({ id: seed.definition_id, name: 'Mock echo agent', capabilities: { skills: ['demo.echo'], controls: { progress_stream: true, active_steer: false, queued_followup: false, cancel: false } } });
    await c.insert(s.agentInstallations).values({ id: seed.installation_id, workspace_id: seed.workspace_id, owner_id: seed.owner_id, definition_id: seed.definition_id, connector_id: 'mock' });
    await c.insert(s.agentGrants).values({ workspace_id: seed.workspace_id, installation_id: seed.installation_id, channel_id: seed.channel_id, skill: 'demo.echo' });
  });
  return seed;
}
