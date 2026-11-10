ALTER TABLE outbound_connections ADD COLUMN credential_revision integer NOT NULL DEFAULT 1;

-- Discovery belongs to the admin who requested it. Demotion must wake the
-- gateway even when the admin remains an active workspace member.
CREATE OR REPLACE TRIGGER outbound_manager_changed AFTER UPDATE OF role ON workspace_members
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role) EXECUTE FUNCTION outbound_authority_changed();

CREATE OR REPLACE FUNCTION outbound_previous_agent_owner_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('space_outbound_changed',json_build_object('schema',TG_TABLE_SCHEMA,'owner',OLD.owner_id)::text);
  RETURN NULL;
END; $$;
CREATE OR REPLACE TRIGGER outbound_previous_agent_owner_changed AFTER UPDATE OF owner_id ON agent_installations
  FOR EACH ROW WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id) EXECUTE FUNCTION outbound_previous_agent_owner_changed();
