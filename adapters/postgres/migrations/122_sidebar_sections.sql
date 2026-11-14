CREATE TABLE sidebar_sections (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  collapsed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  creation_name text NOT NULL,
  creation_channel_id uuid,
  PRIMARY KEY (workspace_id, user_id, id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members ON DELETE CASCADE
);

CREATE TABLE sidebar_section_assignments (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  section_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, user_id, channel_id),
  FOREIGN KEY (workspace_id, user_id, section_id) REFERENCES sidebar_sections ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, user_id) REFERENCES channel_members ON DELETE CASCADE
);
CREATE INDEX sidebar_section_assignments_member ON sidebar_section_assignments(channel_id,user_id);
CREATE INDEX sidebar_section_assignments_section ON sidebar_section_assignments(workspace_id,user_id,section_id);

-- A cascading section deletion wakes each affected actor once per table statement.
CREATE FUNCTION deliver_sidebar_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO resource_update_revisions(resource)
    SELECT DISTINCT 'actor:' || user_id FROM changed_rows ORDER BY 1
    ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
  INSERT INTO chat_delivery_outbox(actor_id,resource_scope)
    SELECT DISTINCT user_id,'none' FROM changed_rows ORDER BY user_id;
  RETURN NULL;
END; $$;
CREATE TRIGGER sidebar_sections_created AFTER INSERT ON sidebar_sections
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
CREATE TRIGGER sidebar_sections_updated AFTER UPDATE ON sidebar_sections
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
CREATE TRIGGER sidebar_sections_removed AFTER DELETE ON sidebar_sections
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
CREATE TRIGGER sidebar_assignments_created AFTER INSERT ON sidebar_section_assignments
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
CREATE TRIGGER sidebar_assignments_updated AFTER UPDATE ON sidebar_section_assignments
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
CREATE TRIGGER sidebar_assignments_removed AFTER DELETE ON sidebar_section_assignments
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
