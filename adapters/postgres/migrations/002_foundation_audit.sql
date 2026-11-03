CREATE TABLE foundation_events (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 installation_id uuid NOT NULL,
 actor_id uuid REFERENCES users NOT NULL,
 type text NOT NULL CHECK(type IN ('installation.created','installation.enabled','installation.disabled','grant.created','grant.revoked')),
 payload jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,installation_id) REFERENCES agent_installations(workspace_id,id)
);
CREATE INDEX foundation_events_installation ON foundation_events(installation_id,occurred_at);
CREATE TRIGGER foundation_events_immutable BEFORE UPDATE OR DELETE ON foundation_events FOR EACH ROW EXECUTE FUNCTION immutable_task_event();
