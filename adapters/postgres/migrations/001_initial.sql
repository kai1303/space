CREATE TABLE users (id uuid PRIMARY KEY);
CREATE TABLE workspaces (id uuid PRIMARY KEY);
CREATE TABLE workspace_members (workspace_id uuid REFERENCES workspaces, user_id uuid REFERENCES users, PRIMARY KEY(workspace_id,user_id));
CREATE TABLE channels (id uuid PRIMARY KEY, workspace_id uuid REFERENCES workspaces NOT NULL, UNIQUE(workspace_id,id));
CREATE TABLE channel_members (workspace_id uuid NOT NULL, channel_id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY(channel_id,user_id), FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id), FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members);
CREATE TABLE threads (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, channel_id uuid NOT NULL, UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id));
CREATE TABLE human_credentials (token_hash text PRIMARY KEY, user_id uuid REFERENCES users NOT NULL);
CREATE TABLE agent_definitions (id uuid PRIMARY KEY, name text NOT NULL, capabilities jsonb NOT NULL);
CREATE TABLE agent_installations (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_id uuid NOT NULL, definition_id uuid REFERENCES agent_definitions NOT NULL, connector_id text NOT NULL, enabled boolean NOT NULL DEFAULT true, UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES workspace_members);
CREATE TABLE agent_grants (workspace_id uuid NOT NULL, installation_id uuid NOT NULL, channel_id uuid NOT NULL, skill text NOT NULL, PRIMARY KEY(installation_id,channel_id,skill), FOREIGN KEY(workspace_id,installation_id) REFERENCES agent_installations(workspace_id,id), FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id));
CREATE TABLE agent_sessions (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, installation_id uuid NOT NULL, origin_thread_id uuid NOT NULL, UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,installation_id) REFERENCES agent_installations(workspace_id,id), FOREIGN KEY(workspace_id,origin_thread_id) REFERENCES threads(workspace_id,id));
CREATE TABLE tasks (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, thread_id uuid NOT NULL, installation_id uuid NOT NULL,
 goal text NOT NULL, skill text NOT NULL, requester_id uuid NOT NULL, approved_by uuid REFERENCES users,
 status text NOT NULL CHECK(status IN ('awaiting_approval','queued','running','completed','failed','rejected')),
 session_id uuid, active_execution_id uuid, revision integer NOT NULL DEFAULT 1, result text,
 idempotency_key text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,requester_id,idempotency_key),
 FOREIGN KEY(workspace_id,thread_id) REFERENCES threads(workspace_id,id),
 FOREIGN KEY(workspace_id,installation_id) REFERENCES agent_installations(workspace_id,id),
 FOREIGN KEY(workspace_id,requester_id) REFERENCES workspace_members,
 FOREIGN KEY(workspace_id,session_id) REFERENCES agent_sessions(workspace_id,id)
);
CREATE TABLE executions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, task_id uuid NOT NULL, installation_id uuid NOT NULL, session_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','completed','failed')), last_sequence integer NOT NULL DEFAULT 0,
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),
 FOREIGN KEY(workspace_id,installation_id) REFERENCES agent_installations(workspace_id,id),
 FOREIGN KEY(workspace_id,session_id) REFERENCES agent_sessions(workspace_id,id)
);
ALTER TABLE tasks ADD FOREIGN KEY(workspace_id,active_execution_id) REFERENCES executions(workspace_id,id);
CREATE TABLE task_events (
 id uuid PRIMARY KEY, schema_version text NOT NULL DEFAULT '1.0', type text NOT NULL,
 workspace_id uuid NOT NULL, actor_id uuid NOT NULL, resource_id uuid NOT NULL,
 correlation_id uuid NOT NULL, causation_id uuid, sequence integer NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,
 UNIQUE(correlation_id,sequence), FOREIGN KEY(workspace_id,correlation_id) REFERENCES tasks(workspace_id,id)
);
CREATE TABLE agent_event_receipts (installation_id uuid REFERENCES agent_installations, event_id uuid NOT NULL, event jsonb NOT NULL, PRIMARY KEY(installation_id,event_id));
CREATE TABLE messages (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, thread_id uuid NOT NULL, task_id uuid NOT NULL UNIQUE, installation_id uuid NOT NULL, text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(workspace_id,thread_id) REFERENCES threads(workspace_id,id), FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id), FOREIGN KEY(workspace_id,installation_id) REFERENCES agent_installations(workspace_id,id));
CREATE TABLE outbox (
 id uuid PRIMARY KEY, task_id uuid REFERENCES tasks NOT NULL UNIQUE, execution_id uuid REFERENCES executions NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivering','done','dead')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token uuid, last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox(available_at) WHERE state IN ('pending','delivering');
CREATE INDEX tasks_thread ON tasks(workspace_id,thread_id);
CREATE FUNCTION immutable_task_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'task events are append-only'; END; $$;
CREATE TRIGGER task_events_immutable BEFORE UPDATE OR DELETE ON task_events FOR EACH ROW EXECUTE FUNCTION immutable_task_event();
