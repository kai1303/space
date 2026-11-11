-- Long-term Knowledge notes. Space is the source of truth; the provider index is a copy.
ALTER TABLE channels ADD COLUMN knowledge_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE knowledge_notes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fact','decision','procedure','answer')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  title_key text GENERATED ALWAYS AS (lower(regexp_replace(btrim(title), '\s+', ' ', 'g'))) STORED,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 16000),
  evidence uuid[] NOT NULL CHECK (cardinality(evidence) BETWEEN 1 AND 20),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  producer_id text NOT NULL,
  producer_name text NOT NULL,
  fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE
);
-- One live note per title per channel. Same-title saves use this as the ON CONFLICT arbiter.
CREATE UNIQUE INDEX knowledge_notes_live_title ON knowledge_notes(channel_id, title_key) WHERE removed_at IS NULL;
CREATE INDEX knowledge_notes_recent ON knowledge_notes(channel_id, updated_at DESC, id DESC) WHERE removed_at IS NULL;

CREATE TABLE knowledge_note_revisions (
  note_id uuid NOT NULL REFERENCES knowledge_notes(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  evidence uuid[] NOT NULL,
  producer_id text NOT NULL,
  producer_name text NOT NULL,
  removed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, revision)
);

-- No text in notifications. The worker reads the row through knowledge_note_sources.
CREATE FUNCTION notify_note_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'knowledge_notes' THEN
    PERFORM pg_notify('space_kb_' || replace(coalesce(NEW.workspace_id, OLD.workspace_id)::text, '-', ''),
      'note/' || coalesce(NEW.channel_id, OLD.channel_id)::text || '/' || coalesce(NEW.id, OLD.id)::text);
  ELSE
    PERFORM pg_notify('space_kb_' || replace(NEW.workspace_id::text, '-', ''), 'reconcile');
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER knowledge_note_changed AFTER INSERT OR UPDATE OR DELETE ON knowledge_notes
  FOR EACH ROW EXECUTE FUNCTION notify_note_knowledge();
CREATE TRIGGER knowledge_notes_switched AFTER UPDATE OF knowledge_enabled ON channels
  FOR EACH ROW WHEN (NEW.knowledge_enabled IS DISTINCT FROM OLD.knowledge_enabled) EXECUTE FUNCTION notify_note_knowledge();

-- Live notes the worker may copy: switch on, channel not archived, not a DM.
CREATE VIEW knowledge_note_sources WITH (security_barrier=true) AS
 SELECT n.workspace_id, n.channel_id, n.id, n.kind, n.title, n.content, n.evidence, n.revision, c.name AS channel_name
 FROM knowledge_notes n JOIN channels c ON c.id = n.channel_id AND c.workspace_id = n.workspace_id
 WHERE n.removed_at IS NULL AND c.kind = 'channel' AND c.archived_at IS NULL AND c.knowledge_enabled;

-- Same audience rule as knowledge_visible_messages() in migration 082.
CREATE FUNCTION knowledge_visible_notes(w uuid, requester uuid, destination uuid, ids uuid[])
 RETURNS TABLE(id uuid, channel_id uuid, kind text, title text, content text, evidence uuid[], revision integer, channel_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT n.id, n.channel_id, n.kind, n.title, n.content, n.evidence, n.revision, n.channel_name
 FROM knowledge_note_sources n JOIN channels src ON src.id = n.channel_id
 JOIN channels dest ON dest.workspace_id = w AND dest.id = destination
 JOIN workspace_members actor ON actor.workspace_id = w AND actor.user_id = requester AND actor.active
 WHERE n.workspace_id = w AND n.id = ANY(ids) AND cardinality(ids) <= 128
 AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id = dest.id AND user_id = requester)
 AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id = src.id AND user_id = requester)
 AND (NOT src.private OR dest.private)
 AND NOT EXISTS(SELECT 1 FROM channel_members cm JOIN workspace_members viewer
      ON viewer.workspace_id = w AND viewer.user_id = cm.user_id AND viewer.active
      WHERE cm.channel_id = dest.id AND (src.private OR viewer.guest_type <> 'none')
      AND NOT EXISTS(SELECT 1 FROM channel_members allowed WHERE allowed.channel_id = src.id AND allowed.user_id = viewer.user_id))
$$;
REVOKE ALL ON FUNCTION knowledge_visible_notes(uuid,uuid,uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION knowledge_visible_notes(uuid,uuid,uuid,uuid[]) SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $$;
