CREATE TABLE outbound_connections (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 20),
 name text NOT NULL, url text NOT NULL, auth_type text NOT NULL CHECK(auth_type IN ('bearer','none')),
 secret text, enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'untested' CHECK(status IN ('untested','ready','error')),
 tools jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,slot)
);
CREATE TABLE outbound_grants (
 connection_id uuid NOT NULL REFERENCES outbound_connections(id) ON DELETE CASCADE,
 installation_id uuid NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
 tools jsonb NOT NULL DEFAULT '[]', PRIMARY KEY(connection_id,installation_id)
);
CREATE TABLE outbound_calls (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), execution_id uuid NOT NULL REFERENCES executions(id),
 request_id text NOT NULL, fingerprint text NOT NULL, connection_id uuid,
 connection_name text NOT NULL, tool_name text NOT NULL, installation_id uuid NOT NULL, agent_name text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','uncertain')),
 created_at timestamptz NOT NULL DEFAULT now(), deadline timestamptz NOT NULL, retain_until timestamptz NOT NULL,
 duration_ms integer, UNIQUE(execution_id,request_id)
);
CREATE INDEX outbound_calls_owner ON outbound_calls(owner_id,created_at DESC,id);
CREATE FUNCTION outbound_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;
BEGIN
 IF TG_TABLE_NAME='outbound_connections' OR TG_TABLE_NAME='outbound_calls' THEN actor:=coalesce(NEW.owner_id,OLD.owner_id);
 ELSE SELECT owner_id INTO actor FROM outbound_connections WHERE id=coalesce(NEW.connection_id,OLD.connection_id); END IF;
 IF actor IS NOT NULL THEN
 IF TG_TABLE_NAME<>'outbound_calls' THEN PERFORM pg_notify('space_outbound_changed',json_build_object('schema',TG_TABLE_SCHEMA,'owner',actor)::text); END IF;
 INSERT INTO resource_update_revisions(resource) VALUES('actor:' || actor) ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
 INSERT INTO chat_delivery_outbox(actor_id,resource_scope) VALUES(actor,'none'); END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER outbound_connection_changed AFTER INSERT OR UPDATE OR DELETE ON outbound_connections FOR EACH ROW EXECUTE FUNCTION outbound_changed();
CREATE TRIGGER outbound_grants_changed AFTER INSERT OR UPDATE OR DELETE ON outbound_grants FOR EACH ROW EXECUTE FUNCTION outbound_changed();
CREATE TRIGGER outbound_calls_changed AFTER INSERT OR UPDATE ON outbound_calls FOR EACH ROW EXECUTE FUNCTION outbound_changed();

CREATE FUNCTION outbound_authority_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;
BEGIN
 IF TG_TABLE_NAME IN ('workspace_members','channel_members') THEN actor:=coalesce(NEW.user_id,OLD.user_id);
 ELSIF TG_TABLE_NAME='agent_installations' THEN actor:=coalesce(NEW.owner_id,OLD.owner_id);
 ELSE SELECT owner_id INTO actor FROM agent_installations WHERE id=coalesce(NEW.installation_id,OLD.installation_id); END IF;
 IF actor IS NOT NULL THEN PERFORM pg_notify('space_outbound_changed',json_build_object('schema',TG_TABLE_SCHEMA,'owner',actor)::text); END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER outbound_membership_changed AFTER UPDATE OF active OR DELETE ON workspace_members FOR EACH ROW EXECUTE FUNCTION outbound_authority_changed();
CREATE TRIGGER outbound_channel_access_changed AFTER DELETE ON channel_members FOR EACH ROW EXECUTE FUNCTION outbound_authority_changed();
CREATE TRIGGER outbound_agent_changed AFTER UPDATE OF enabled,owner_id OR DELETE ON agent_installations FOR EACH ROW EXECUTE FUNCTION outbound_authority_changed();
CREATE TRIGGER outbound_connector_changed AFTER UPDATE OF revoked_at OR DELETE ON agent_connections FOR EACH ROW EXECUTE FUNCTION outbound_authority_changed();
CREATE TRIGGER outbound_session_changed AFTER UPDATE OF state ON agent_sessions FOR EACH ROW EXECUTE FUNCTION outbound_authority_changed();
CREATE TRIGGER outbound_task_changed AFTER UPDATE OF status,requester_id,active_execution_id ON tasks FOR EACH ROW EXECUTE FUNCTION outbound_authority_changed();
CREATE TRIGGER outbound_execution_changed AFTER UPDATE OF status ON executions FOR EACH ROW EXECUTE FUNCTION outbound_authority_changed();
