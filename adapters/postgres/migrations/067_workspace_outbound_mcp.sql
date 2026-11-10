ALTER TABLE outbound_connections
  ALTER COLUMN owner_id DROP NOT NULL,
  ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT outbound_connection_scope CHECK (num_nonnulls(owner_id,workspace_id)=1),
  ADD CONSTRAINT outbound_workspace_slot UNIQUE(workspace_id,slot);

CREATE OR REPLACE FUNCTION outbound_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; workspace uuid;
BEGIN
  IF TG_TABLE_NAME='outbound_calls' THEN
    actor:=coalesce(NEW.owner_id,OLD.owner_id);
  ELSIF TG_TABLE_NAME='outbound_connections' THEN
    actor:=coalesce(NEW.owner_id,OLD.owner_id);
    workspace:=coalesce(NEW.workspace_id,OLD.workspace_id);
  ELSE
    SELECT owner_id,workspace_id INTO actor,workspace FROM outbound_connections
      WHERE id=coalesce(NEW.connection_id,OLD.connection_id);
  END IF;
  IF workspace IS NOT NULL THEN
    PERFORM pg_notify('space_outbound_changed',json_build_object('schema',TG_TABLE_SCHEMA,'owner','workspace:' || workspace)::text);
    INSERT INTO chat_delivery_outbox(workspace_id,resource_scope) VALUES(workspace,'metadata');
  ELSIF actor IS NOT NULL THEN
    IF TG_TABLE_NAME<>'outbound_calls' THEN
      PERFORM pg_notify('space_outbound_changed',json_build_object('schema',TG_TABLE_SCHEMA,'owner',actor)::text);
    END IF;
    INSERT INTO resource_update_revisions(resource) VALUES('actor:' || actor)
      ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
    INSERT INTO chat_delivery_outbox(actor_id,resource_scope) VALUES(actor,'none');
  END IF;
  RETURN NULL;
END; $$;
