CREATE TABLE workspace_preferences (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  icon_url text CHECK (octet_length(icon_url) <= 200000),
  slug text UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  default_channel_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(default_channel_ids) <= 25),
  approved_email_domains text[] NOT NULL DEFAULT '{}' CHECK (cardinality(approved_email_domains) <= 50),
  language text NOT NULL DEFAULT 'en',
  display_name_guidelines text NOT NULL DEFAULT '' CHECK (char_length(display_name_guidelines) <= 2000),
  email_visibility text NOT NULL DEFAULT 'admins' CHECK (email_visibility IN ('admins', 'members')),
  invite_permission text NOT NULL DEFAULT 'admins' CHECK (invite_permission IN ('admins', 'members')),
  create_channel_permission text NOT NULL DEFAULT 'members' CHECK (create_channel_permission IN ('admins', 'members')),
  retention_days integer CHECK (retention_days BETWEEN 1 AND 36500)
);

CREATE TRIGGER workspace_preferences_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON workspace_preferences FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
