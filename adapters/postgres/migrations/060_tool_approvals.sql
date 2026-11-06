CREATE TABLE agent_tool_approvals (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES agent_sessions(id),
 task_id uuid NOT NULL REFERENCES tasks(id),
 execution_id uuid NOT NULL REFERENCES executions(id),
 installation_id uuid NOT NULL REFERENCES agent_installations(id),
 connection_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('project','command','file_change','permissions')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 details text NOT NULL CHECK(length(details) BETWEEN 1 AND 8000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','allow','deny','cancelled')),
 decided_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz, consumed_at timestamptz
);
CREATE INDEX agent_tool_approvals_session ON agent_tool_approvals(session_id,created_at DESC,id DESC);
CREATE INDEX agent_tool_approvals_execution ON agent_tool_approvals(execution_id);
CREATE FUNCTION enqueue_tool_approval_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s agent_sessions; ch uuid;
BEGIN
 SELECT * INTO s FROM agent_sessions WHERE id=NEW.session_id;
 SELECT channel_id INTO ch FROM threads WHERE id=s.origin_thread_id;
 INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('chat.changed',ch::text,
  jsonb_build_object('channel_id',ch,'workspace_id',s.workspace_id,'resource_scope','thread','resource_id',s.origin_thread_id,
    'keys',ARRAY['thread:'||s.origin_thread_id::text,'tool-approval:'||NEW.id::text]));
 RETURN NULL;
END; $$;
CREATE TRIGGER tool_approval_change AFTER INSERT OR UPDATE ON agent_tool_approvals
 FOR EACH ROW EXECUTE FUNCTION enqueue_tool_approval_change();
