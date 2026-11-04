import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { migrate, migrationFiles } from '@space/postgres/migrate';
import { database } from '@space/postgres/database';
import { PostgresStore } from '@space/postgres/store';
import { WorkspaceStore } from '@space/postgres/workspace';
import { UserStore } from '@space/postgres/users';
import { provisionUser, initializeWorkspaceOwner } from '@space/postgres/provisioning';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
test('legacy upgrade preserves membership without granting ownership; operator assignment is explicit and once-only', async () => {
  const schema = `legacy_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const user = randomUUID(), other = randomUUID(), workspace = randomUUID();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migrateUrl = import.meta.resolve('@space/postgres/migrate');
    for (const file of ['001_initial.sql', '002_foundation_audit.sql']) {
      await pool.query(await readFile(new URL(`./migrations/${file}`, migrateUrl), 'utf8'));
    }
    await pool.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations(version) VALUES (1),(2)');
    await pool.query('INSERT INTO users(id) VALUES ($1),($2)', [user, other]);
    await pool.query('INSERT INTO workspaces(id) VALUES ($1)', [workspace]);
    await pool.query('INSERT INTO workspace_members(workspace_id,user_id) VALUES ($1,$2),($1,$3)', [workspace, user, other]);
    await migrate(pool);
    await migrate(pool);
    const workspaces = new WorkspaceStore(pool);
    assert.equal((await workspaces.read(user, workspace)).role, 'member');
    assert.equal((await workspaces.members(user, workspace)).items.length, 2);
    await initializeWorkspaceOwner(pool, workspace, user);
    await initializeWorkspaceOwner(pool, workspace, user);
    assert.equal((await workspaces.read(user, workspace)).role, 'owner');
    await assert.rejects(initializeWorkspaceOwner(pool, workspace, other), { code: 'owner_already_initialized' });
    assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, migrationFiles.length);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('operator provisioning stores only a token hash and rolls back with its surrounding transaction', async () => {
  const schema = `users_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await assert.rejects(database(pool).transaction(async tx => {
      await provisionUser(tx, { display_name: 'Uncommitted' });
      throw new Error('credential file write failed');
    }), /credential file/);
    assert.equal((await pool.query('SELECT * FROM users')).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM human_credentials')).rowCount, 0);
    const user = await database(pool).transaction(tx => provisionUser(tx, { display_name: 'New user' }));
    assert.equal(await new PostgresStore(pool).authenticate(user.token), user.id);
    const credential = (await pool.query('SELECT * FROM human_credentials')).rows[0];
    assert.notEqual(credential.token_hash, user.token);
    assert.equal((await new UserStore(pool).profile(user.id)).display_name, 'New user');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('version-three upgrade preserves workspace identities, roles, inactive members, tasks and audit rows', async () => {
  const schema = `upgrade_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const user = randomUUID(), removed = randomUUID(), workspace = randomUUID(), second = randomUUID();
  const channel = randomUUID(), thread = randomUUID(), definition = randomUUID(), installation = randomUUID(), task = randomUUID(), event = randomUUID();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migrateUrl = import.meta.resolve('@space/postgres/migrate');
    for (const file of ['001_initial.sql', '002_foundation_audit.sql', '003_organization_users.sql']) {
      await pool.query(await readFile(new URL(`./migrations/${file}`, migrateUrl), 'utf8'));
    }
    await pool.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations(version) VALUES (1),(2),(3)');
    await pool.query("INSERT INTO users(id,display_name) VALUES ($1,'Owner'),($2,'Removed')", [user, removed]);
    await pool.query("INSERT INTO workspaces(id,name) VALUES ($1,'Legacy One'),($2,'Legacy Two')", [workspace, second]);
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,active) VALUES ($1,$3,'owner',true),($1,$4,'admin',false),($2,$3,'member',true)", [workspace, second, user, removed]);
    await pool.query('INSERT INTO channels(id,workspace_id) VALUES ($1,$2)', [channel, workspace]);
    await pool.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES ($1,$2,$3)', [thread, workspace, channel]);
    await pool.query("INSERT INTO agent_definitions(id,name,capabilities) VALUES ($1,'Existing','{\"skills\":[\"echo\"],\"controls\":{}}')", [definition]);
    await pool.query("INSERT INTO agent_installations(id,workspace_id,owner_id,definition_id,connector_id) VALUES ($1,$2,$3,$4,'mock')", [installation, workspace, user, definition]);
    await pool.query("INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,idempotency_key,request_hash) VALUES ($1,$2,$3,$4,'Existing task','echo',$5,'awaiting_approval','key','hash')", [task, workspace, thread, installation, user]);
    await pool.query("INSERT INTO organization_events(id,workspace_id,actor_id,type,payload) VALUES ($1,$2,$3,'organization.created','{\"name\":\"Legacy One\"}')", [event, workspace, user]);
    const oldEvent = (await pool.query('SELECT * FROM organization_events WHERE id=$1', [event])).rows[0];
    const oldTask = (await pool.query('SELECT * FROM tasks WHERE id=$1', [task])).rows[0];
    await migrate(pool);
    await migrate(pool);
    const workspaces = (await pool.query('SELECT id,name FROM workspaces ORDER BY id')).rows;
    assert.deepEqual(new Map(workspaces.map(row => [row.id, row.name])), new Map([[workspace, 'Legacy One'], [second, 'Legacy Two']]));
    assert.equal((await new WorkspaceStore(pool).read(user, workspace)).role, 'owner');
    assert.equal((await new WorkspaceStore(pool).read(user, second)).role, 'member');
    const inactive = (await pool.query('SELECT * FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspace, removed])).rows[0];
    assert.equal(inactive.active, false);
    assert.equal(inactive.role, 'admin');
    assert.deepEqual((await pool.query('SELECT * FROM workspace_events WHERE id=$1', [event])).rows[0], oldEvent);
    assert.deepEqual((await pool.query('SELECT * FROM tasks WHERE id=$1', [task])).rows[0], { ...oldTask, request_document: null });
    await assert.rejects(pool.query('UPDATE workspace_events SET type=$1 WHERE id=$2', ['changed', event]), /append-only/);
    assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, migrationFiles.length);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('version-thirteen upgrade preserves workspace history and roles without restoring revoked parent access', async () => {
  const schema = `flatten_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const organization = randomUUID(), workspace = randomUUID();
  const owner = randomUUID(), member = randomUUID(), revoked = randomUUID(), inactive = randomUUID();
  const channel = randomUUID(), thread = randomUUID(), definition = randomUUID(), installation = randomUUID();
  const task = randomUUID(), message = randomUUID(), asset = randomUUID(), event = randomUUID();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const directory = new URL('./migrations/', import.meta.resolve('@space/postgres/migrate'));
    const files = (await readdir(directory)).filter(file => /^\d{3}_.*\.sql$/.test(file) && Number(file.slice(0, 3)) <= 13).sort();
    assert.equal(files.length, 13);
    await pool.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      await pool.query(await readFile(new URL(file, directory), 'utf8'));
      await pool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [Number(file.slice(0, 3))]);
    }
    await pool.query("INSERT INTO users(id,display_name) VALUES ($1,'Owner'),($2,'Org owner only'),($3,'Revoked parent'),($4,'Inactive workspace')", [owner, member, revoked, inactive]);
    await pool.query("INSERT INTO organizations(id,name) VALUES ($1,'Retired parent')", [organization]);
    await pool.query("INSERT INTO organization_members(organization_id,user_id,role,active) VALUES ($1,$2,'owner',true),($1,$3,'owner',true),($1,$4,'admin',false),($1,$5,'owner',true)", [organization, owner, member, revoked, inactive]);
    await pool.query("INSERT INTO workspaces(id,organization_id,name) VALUES ($1,$2,'Keep this identity')", [workspace, organization]);
    await pool.query("INSERT INTO workspace_members(workspace_id,organization_id,user_id,role,active) VALUES ($1,$2,$3,'owner',true),($1,$2,$4,'member',true),($1,$2,$5,'admin',true),($1,$2,$6,'owner',false)", [workspace, organization, owner, member, revoked, inactive]);
    await pool.query("INSERT INTO channels(id,workspace_id,name) VALUES ($1,$2,'retained-channel')", [channel, workspace]);
    await pool.query('INSERT INTO channel_members(workspace_id,channel_id,user_id) VALUES ($1,$2,$3),($1,$2,$4),($1,$2,$5)', [workspace, channel, owner, revoked, inactive]);
    await pool.query('INSERT INTO threads(id,workspace_id,channel_id) VALUES ($1,$2,$3)', [thread, workspace, channel]);
    await pool.query("INSERT INTO agent_definitions(id,name,capabilities) VALUES ($1,'Retained agent','{\"skills\":[\"echo\"],\"controls\":{}}')", [definition]);
    await pool.query("INSERT INTO agent_installations(id,workspace_id,owner_id,definition_id,connector_id) VALUES ($1,$2,$3,$4,'mock')", [installation, workspace, revoked, definition]);
    await pool.query("INSERT INTO agent_connections(installation_id,name,token_hash,auth_status) VALUES ($1,'Existing connection','legacy-connection-hash','ready')", [installation]);
    await pool.query("INSERT INTO tasks(id,workspace_id,thread_id,installation_id,goal,skill,requester_id,status,idempotency_key,request_hash) VALUES ($1,$2,$3,$4,'Retain task','echo',$5,'completed','legacy-key','legacy-hash')", [task, workspace, thread, installation, revoked]);
    await pool.query("INSERT INTO messages(id,workspace_id,thread_id,channel_id,task_id,installation_id,text) VALUES ($1,$2,$3,$4,$5,$6,'Retain chat history')", [message, workspace, thread, channel, task, installation]);
    await pool.query("INSERT INTO assets(id,workspace_id,channel_id,uploader_id,name,size,type,staging_key,object_key,status,message_id) VALUES ($1,$2,$3,$4,'retained.txt',12,'text/plain','legacy-staging','legacy-object','ready',$5)", [asset, workspace, channel, revoked, message]);
    await pool.query("INSERT INTO workspace_events(id,workspace_id,actor_id,type,payload) VALUES ($1,$2,$3,'workspace.created','{}')", [event, workspace, owner]);
    const retainedTables = ['users', 'channels', 'threads', 'tasks', 'messages', 'assets', 'workspace_events', 'channel_events', 'agent_definitions', 'agent_connections'] as const;
    const before = new Map<string, unknown>();
    const originalColumns = new Map<string, string>();
    for (const table of retainedTables) {
      const result = await pool.query(`SELECT * FROM ${table}`);
      before.set(table, result.rows);
      originalColumns.set(table, result.fields.map(field => `"${field.name}"`).join(','));
    }
    const oldWorkspace = (await pool.query('SELECT id,name,created_at FROM workspaces')).rows;
    const oldMemberships = (await pool.query('SELECT workspace_id,user_id,role,joined_at FROM workspace_members ORDER BY user_id')).rows;
    const oldInstallation = (await pool.query('SELECT * FROM agent_installations WHERE id=$1', [installation])).rows[0];

    await migrate(pool);
    await migrate(pool);

    assert.deepEqual((await pool.query('SELECT id,name,created_at FROM workspaces')).rows, oldWorkspace);
    assert.deepEqual((await pool.query('SELECT workspace_id,user_id,role,joined_at FROM workspace_members ORDER BY user_id')).rows, oldMemberships);
    for (const table of retainedTables) {
      // Additive migrations must preserve every column that existed in v13.
      const rows = (await pool.query(`SELECT ${originalColumns.get(table)} FROM ${table}`)).rows;
      assert.deepEqual(rows, before.get(table), `${table} history changed`);
    }
    assert.deepEqual((await pool.query('SELECT kind,direct_user_low,direct_user_high FROM channels')).rows, [{kind:'channel',direct_user_low:null,direct_user_high:null}]);
    assert.deepEqual((await pool.query('SELECT request_document FROM tasks')).rows, [{request_document:null}]);
    assert.deepEqual((await pool.query('SELECT retained_at FROM messages')).rows, [{retained_at:null}]);
    const messageSequence = (await pool.query('SELECT sequence FROM messages WHERE id=$1', [message])).rows[0].sequence;
    const originalMessageEvent = (before.get('channel_events') as { type: string; sequence: string; payload: { id: string } }[])
      .find(row => row.type === 'message.created' && row.payload.id === message)!;
    assert.equal(messageSequence, originalMessageEvent.sequence);
    assert.deepEqual((await pool.query('SELECT * FROM agent_installations WHERE id=$1', [installation])).rows[0], { ...oldInstallation, enabled: false });
    const workspaces = new WorkspaceStore(pool);
    assert.equal((await workspaces.read(owner, workspace)).role, 'owner');
    assert.equal((await workspaces.read(member, workspace)).role, 'member');
    await assert.rejects(workspaces.rename(member, workspace, { name: 'No inherited authority' }), { status: 403 });
    for (const user of [revoked, inactive]) {
      assert.equal((await pool.query('SELECT active FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspace, user])).rows[0].active, false);
      assert.equal((await pool.query('SELECT * FROM channel_members WHERE workspace_id=$1 AND user_id=$2', [workspace, user])).rowCount, 0);
      await assert.rejects(workspaces.read(user, workspace), { status: 404 });
      await assert.rejects(new PostgresStore(pool).readTask(user, task), { status: 404 });
    }
    assert.equal((await pool.query('SELECT * FROM channel_members WHERE workspace_id=$1 AND user_id=$2', [workspace, owner])).rowCount, 1);
    assert.equal((await new PostgresStore(pool).readTask(owner, task)).id, task);
    assert.equal((await pool.query("SELECT * FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('organizations','organization_members','organization_events')")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='organization_id'")).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, migrationFiles.length);
    await assert.rejects(pool.query('UPDATE workspace_events SET type=$1 WHERE id=$2', ['changed', event]), /append-only/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
