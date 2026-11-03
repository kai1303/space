import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { database } from './database.js';
import { schemaMigrations } from './schema.js';

export const migrationFiles = [
  '001_initial.sql', '002_foundation_audit.sql', '003_organization_users.sql',
  '004_organization_hierarchy.sql', '005_realtime_chat.sql', '006_better_auth.sql',
  '007_rich_chat_messages.sql', '008_agent_connections.sql', '009_assets.sql',
  '010_asset_previews.sql', '011_channel_memory.sql', '012_memory_mcp.sql',
  '013_user_profiles.sql', '014_workspaces_only.sql', '015_channel_files.sql',
  '016_message_history.sql', '017_channel_management.sql', '018_chat_partitions.sql',
  '019_chat_delivery_outbox.sql', '020_navigator.sql', '021_agent_responses.sql',
  '022_local_codex_execution.sql', '023_message_reactions.sql', '024_storage_claims.sql',
  '025_mentions.sql', '026_thread_context.sql', '027_channel_reads.sql', '028_thread_messages.sql',
] as const;

export async function migrate(pool: Pool): Promise<void> {
  const migrations = await Promise.all(migrationFiles.map(file => readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8')));
  await database(pool).transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':migrations'))`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const [index, migration] of migrations.entries()) {
      const version = index + 1;
      if ((await tx.select().from(schemaMigrations).where(eq(schemaMigrations.version, version))).length) continue;
      // Only version-controlled local migration files use raw SQL, never request input.
      await tx.execute(sql.raw(migration));
      await tx.insert(schemaMigrations).values({ version });
    }
  });
}
