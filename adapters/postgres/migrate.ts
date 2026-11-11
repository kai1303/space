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
  '029_resource_updates.sql', '030_agent_sessions.sql', '031_agent_session_revisions.sql', '032_event_stream.sql', '033_thread_agent_session_entries.sql', '034_inline_agent_session_links.sql', '035_session_request_documents.sql', '036_local_agent_providers.sql', '037_agent_connector_capabilities.sql', '038_agent_memory_grants.sql', '039_direct_messages.sql', '040_notifications.sql', '041_workspace_hub.sql', '042_file_library.sql', '043_workspace_todos.sql', '044_workspace_settings.sql', '045_workspace_invitations.sql', '046_workspace_membership.sql', '047_workspace_retention.sql', '048_todo_sync.sql',
  '049_realtime_targets.sql', '050_message_search.sql', '051_dm_calls.sql', '052_sidekick_sessions.sql', '053_session_sidebar.sql', '054_agent_session_stars.sql', '055_claude_provider.sql', '056_direct_codex_turns.sql', '057_navigator_orchestration.sql', '058_personal_outbound_mcp.sql',
  '059_channel_huddles.sql', '060_tool_approvals.sql', '061_channel_permissions.sql', '062_message_event_operation.sql', '063_message_deletion.sql',
  '064_session_refresh.sql', '065_notification_sounds.sql', '066_agent_session_creation_title.sql', '067_workspace_outbound_mcp.sql',
  '068_session_sidebar_activity.sql', '069_thread_reply_summary.sql', '070_outbound_authority_notifications.sql', '071_workflow_messages.sql', '072_channel_webhooks.sql', '073_published_help_workflows.sql', '074_workflow_edits.sql', '075_channel_message_pins.sql', '076_channel_tabs.sql', '077_channel_tab_order.sql',
] as const;

export async function migrate(pool: Pool): Promise<void> {
  const migrations = await Promise.all(migrationFiles.map(file => readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8')));
  await database(pool).transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':migrations'))`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const [index, migration] of migrations.entries()) {
      // Keep migration identities stable when independent branches leave gaps in the list.
      const version = Number(migrationFiles[index]!.split('_')[0]);
      if ((await tx.select().from(schemaMigrations).where(eq(schemaMigrations.version, version))).length) continue;
      // Only version-controlled local migration files use raw SQL, never request input.
      await tx.execute(sql.raw(migration));
      await tx.insert(schemaMigrations).values({ version });
    }
  });
}
