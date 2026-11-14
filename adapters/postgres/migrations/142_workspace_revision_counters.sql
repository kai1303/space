-- Concurrent writes to different channels also advance the workspace subscription.
-- Spread those increments over bounded counters. Summing committed increments preserves
-- monotonic revisions, including when transactions commit in a different order.
CREATE TABLE workspace_revision_counters (
  resource text NOT NULL,
  bucket smallint NOT NULL CHECK (bucket BETWEEN 0 AND 63),
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (resource, bucket)
);

CREATE VIEW resource_revision_totals AS
  SELECT resource, sum(revision)::bigint AS revision
  FROM (
    SELECT resource, revision FROM resource_update_revisions
    UNION ALL
    SELECT resource, revision FROM workspace_revision_counters
  ) counters GROUP BY resource;

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
  INSERT INTO workspace_revision_counters(resource,bucket) VALUES(target,pg_backend_pid() % 64)
    ON CONFLICT(resource,bucket) DO UPDATE SET revision=workspace_revision_counters.revision+1;
  RETURN NULL;
END; $$;
