-- A retry gets a new transaction ID even when the pool reuses the same backend.
-- Spread consecutive transactions across the existing 64 committed counters.
CREATE OR REPLACE FUNCTION advance_resource_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace uuid; target text;
BEGIN
  IF NEW.resource_scope='none' THEN RETURN NULL; END IF;
  IF NEW.resource_scope IN ('task','thread') THEN
    IF NEW.resource_id IS NOT NULL THEN
      INSERT INTO resource_update_revisions(resource) VALUES(NEW.resource_scope || ':' || NEW.resource_id)
        ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
    END IF;
    RETURN NULL;
  END IF;
  workspace := coalesce(NEW.workspace_id,(SELECT workspace_id FROM channels WHERE id=NEW.channel_id));
  IF NEW.resource_scope='message' THEN
    target := 'workspace-messages:' || workspace;
  ELSE
    IF NEW.channel_id IS NOT NULL THEN
      INSERT INTO resource_update_revisions(resource) VALUES('channel:' || NEW.channel_id)
        ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
    END IF;
    target := coalesce('workspace:' || workspace,'global');
  END IF;
  INSERT INTO workspace_revision_counters(resource,bucket) VALUES(target,txid_current() % 64)
    ON CONFLICT(resource,bucket) DO UPDATE SET revision=workspace_revision_counters.revision+1;
  RETURN NULL;
END; $$;
