import { pgTable, primaryKey, uuid, text, boolean, integer, bigint, jsonb, timestamp } from 'drizzle-orm/pg-core';
import type { AgentCapabilities, AgentEvent, TaskStatus, MemberRole, RichDocument, AssetAttachment, AssetPreview } from '@space/contracts';

// Query mappings for the existing database. Reviewed SQL migrations remain the DDL
// source of truth, including composite foreign keys, indexes, checks and audit triggers.
const id = () => uuid().primaryKey();
const time = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const users = pgTable('users', { id: id(), display_name: text().notNull().default('User'), created_at: time(),
  email: text(), email_verified: boolean().notNull().default(false), image: text(), updated_at: time(),
  full_name: text().notNull().default(''), title: text().notNull().default(''), name_pronunciation: text().notNull().default(''),
  phone: text().notNull().default(''), time_zone: text().notNull().default('UTC'),
  presence: text().$type<'active' | 'away'>().notNull().default('active'), status: jsonb().$type<import('@space/contracts').UserStatus>(),
});
export const workspaces = pgTable('workspaces', { id: id(), name: text().notNull().default('Workspace'), created_at: time() });
export const workspaceMembers = pgTable('workspace_members', {
  workspace_id: uuid().notNull(), user_id: uuid().notNull(), role: text().$type<MemberRole>().notNull().default('member'),
  active: boolean().notNull().default(true), joined_at: time(),
});
export const workspaceEvents = pgTable('workspace_events', {
  id: id(), workspace_id: uuid().notNull(), actor_id: uuid().notNull(), type: text().notNull(),
  payload: jsonb().$type<object>().notNull(), occurred_at: time(),
});
export const channels = pgTable('channels', {
  id: id(), workspace_id: uuid().notNull(), name: text().notNull().default('general'), private: boolean().notNull().default(true),
  topic: text().notNull().default(''), description: text().notNull().default(''), archived_at: timestamp({ withTimezone: true }),
  memory_enabled: boolean().notNull().default(false), memory_provider: text().notNull().default('markdown'),
  created_by: uuid(), event_sequence: bigint({ mode: 'bigint' }).notNull().default(0n), created_at: time(),
});
export const channelEvents = pgTable('channel_events', {
  workspace_id: uuid().notNull(), channel_id: uuid().notNull(), thread_id: uuid().notNull(), sequence: bigint({ mode: 'bigint' }).notNull(),
  type: text().notNull(), payload: jsonb().$type<unknown>().notNull(), occurred_at: time(),
}, table => [primaryKey({ columns: [table.channel_id, table.sequence] })]);
export const channelMembers = pgTable('channel_members', { workspace_id: uuid().notNull(), channel_id: uuid().notNull(), user_id: uuid().notNull() });
export const memoryConnections = pgTable('memory_connections', {
  id: id(), workspace_id: uuid().notNull(), channel_id: uuid().notNull(), created_by: uuid().notNull(),
  name: text().notNull(), access: text().$type<'read' | 'write'>().notNull(), token_hash: text().notNull(), created_at: time(),
});
export const threads = pgTable('threads', { id: id(), workspace_id: uuid().notNull(), channel_id: uuid().notNull() });
export const humanCredentials = pgTable('human_credentials', { token_hash: text().primaryKey(), user_id: uuid().notNull() });
export const agentDefinitions = pgTable('agent_definitions', { id: id(), name: text().notNull(), capabilities: jsonb().$type<AgentCapabilities>().notNull() });
export const agentInstallations = pgTable('agent_installations', { id: id(), workspace_id: uuid().notNull(), owner_id: uuid().notNull(), definition_id: uuid().notNull(), connector_id: text().notNull(), enabled: boolean().notNull().default(true) });
export const agentGrants = pgTable('agent_grants', { workspace_id: uuid().notNull(), installation_id: uuid().notNull(), channel_id: uuid().notNull(), skill: text().notNull() });
export const agentSessions = pgTable('agent_sessions', { id: id(), workspace_id: uuid().notNull(), installation_id: uuid().notNull(), origin_thread_id: uuid().notNull() });
export const tasks = pgTable('tasks', {
  id: id(), workspace_id: uuid().notNull(), thread_id: uuid().notNull(), installation_id: uuid().notNull(),
  goal: text().notNull(), skill: text().notNull(), requester_id: uuid().notNull(), approved_by: uuid(),
  status: text().$type<TaskStatus>().notNull(), session_id: uuid(), active_execution_id: uuid(),
  revision: integer().notNull().default(1), result: text(), idempotency_key: text().notNull(), request_hash: text().notNull(),
  created_at: time(), updated_at: time(),
});
export const executions = pgTable('executions', {
  id: id(), workspace_id: uuid().notNull(), task_id: uuid().notNull(), installation_id: uuid().notNull(), session_id: uuid().notNull(),
  status: text().$type<'queued' | 'running' | 'completed' | 'failed'>().notNull(), last_sequence: integer().notNull().default(0),
});
export const taskEvents = pgTable('task_events', {
  id: id(), schema_version: text().$type<'1.0'>().notNull().default('1.0'), type: text().notNull(), workspace_id: uuid().notNull(),
  actor_id: uuid().notNull(), resource_id: uuid().notNull(), correlation_id: uuid().notNull(), causation_id: uuid(),
  sequence: integer().notNull(), occurred_at: time(), payload: jsonb().$type<Record<string, unknown>>().notNull(),
});
export const agentEventReceipts = pgTable('agent_event_receipts', { installation_id: uuid().notNull(), event_id: uuid().notNull(), event: jsonb().$type<AgentEvent>().notNull() });
export const messages = pgTable('messages', {
  // The insert trigger replaces this placeholder under the channel row lock.
  sequence: bigint({ mode: 'bigint' }).notNull().default(0n),
  id: uuid().notNull(), workspace_id: uuid().notNull(), channel_id: uuid().notNull(), thread_id: uuid().notNull(), task_id: uuid(), installation_id: uuid(),
  author_type: text().$type<'human' | 'agent'>().notNull().default('agent'), user_id: uuid(), client_message_id: uuid(), request_hash: text(),
  text: text().notNull(), document: jsonb().$type<RichDocument>(), attachments: jsonb().$type<AssetAttachment[]>().notNull().default([]), created_at: time(),
}, table => [primaryKey({ columns: [table.channel_id, table.id] })]);
export const messageIdentities = pgTable('message_identities', {
  id: id(), workspace_id: uuid().notNull(), channel_id: uuid().notNull(), task_id: uuid(),
  user_id: uuid(), client_message_id: uuid(), request_hash: text(),
});
export const assets = pgTable('assets', {
  id: id(), workspace_id: uuid().notNull(), channel_id: uuid().notNull(), uploader_id: uuid().notNull(),
  name: text().notNull(), size: integer().notNull(), type: text().notNull(),
  staging_key: text().notNull(), object_key: text().notNull(), status: text().$type<'pending' | 'ready'>().notNull().default('pending'),
  message_id: uuid(), upload_expires_at: timestamp({ withTimezone: true }).notNull(), expires_at: timestamp({ withTimezone: true }).notNull(),
  staging_deleted_at: timestamp({ withTimezone: true }), created_at: time(),
  preview: jsonb().$type<AssetPreview>(),
});
export const outbox = pgTable('outbox', {
  id: id(), task_id: uuid().notNull(), execution_id: uuid().notNull(), state: text().$type<'pending' | 'delivering' | 'done' | 'dead'>().notNull().default('pending'),
  attempts: integer().notNull().default(0), available_at: time(), lease_until: timestamp({ withTimezone: true }), lease_token: uuid(), last_error: text(), created_at: time(),
});
export const foundationEvents = pgTable('foundation_events', { id: id(), workspace_id: uuid().notNull(), installation_id: uuid().notNull(), actor_id: uuid().notNull(), type: text().notNull(), payload: jsonb().$type<object>().notNull(), occurred_at: time() });
export const schemaMigrations = pgTable('schema_migrations', { version: integer().primaryKey(), applied_at: time() });

// Better Auth uses camelCase field keys mapped to the application's SQL naming.
export const authSessions = pgTable('auth_sessions', {
  id: id(), userId: uuid('user_id').notNull(), token: text().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'), userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const authAccounts = pgTable('auth_accounts', {
  id: id(), userId: uuid('user_id').notNull(), accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(),
  accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }), scope: text(), password: text(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const authVerifications = pgTable('auth_verifications', {
  id: id(), identifier: text().notNull(), value: text().notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const authRateLimits = pgTable('auth_rate_limits', {
  id: id(), key: text().notNull(), count: integer().notNull(), lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

export const agentPairings = pgTable('agent_pairings', {
  id: id(), workspace_id: uuid().notNull(), owner_id: uuid().notNull(), name: text().notNull(), code_hash: text().notNull(),
  expires_at: timestamp({ withTimezone: true }).notNull(), cancelled_at: timestamp({ withTimezone: true }), installation_id: uuid(), created_at: time(),
});
export const agentConnections = pgTable('agent_connections', {
  installation_id: uuid().primaryKey(), name: text().notNull(), token_hash: text(),
  auth_status: text().$type<import('@space/contracts').AgentAuthStatus>().notNull().default('required'),
  connection_id: uuid(), last_seen_at: timestamp({ withTimezone: true }), revoked_at: timestamp({ withTimezone: true }), created_at: time(),
});
