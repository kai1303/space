ALTER TABLE agent_sessions ADD COLUMN parent_session_id uuid REFERENCES agent_sessions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX agent_session_helpers ON agent_sessions(parent_session_id, created_at, id) WHERE parent_session_id IS NOT NULL;
