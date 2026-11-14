CREATE TABLE codex_session_archives (
  session_id uuid PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  desired boolean,
  native_thread_id uuid
);
CREATE INDEX codex_archive_native_thread ON codex_session_archives(native_thread_id) WHERE native_thread_id IS NOT NULL;
CREATE INDEX codex_archive_session_page ON agent_sessions(installation_id,id) WHERE managed;

INSERT INTO codex_session_archives(session_id,desired)
SELECT a.id,true FROM agent_sessions a
JOIN agent_installations i ON i.id=a.installation_id AND i.connector_id='codex.local'
JOIN session_sidebar_preferences p ON p.session_id=a.id AND p.user_id=i.owner_id
WHERE a.managed AND p.archived;

CREATE FUNCTION wake_codex_archive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE installation uuid;
BEGIN
  SELECT installation_id INTO installation FROM agent_sessions WHERE id=NEW.session_id;
  PERFORM pg_notify('space_direct_turn', json_build_object('keys',ARRAY['codex-archive:'||installation])::text);
  RETURN NULL;
END; $$;
CREATE TRIGGER codex_archive_requested AFTER INSERT OR UPDATE ON codex_session_archives
  FOR EACH ROW WHEN (NEW.desired IS NOT NULL) EXECUTE FUNCTION wake_codex_archive();

CREATE FUNCTION wake_session_archive_sidebar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('space_direct_turn', json_build_object('keys',ARRAY['workspace:'||NEW.workspace_id])::text);
  RETURN NULL;
END; $$;
CREATE TRIGGER session_archive_sidebar_insert AFTER INSERT ON session_sidebar_preferences
  FOR EACH ROW WHEN (NEW.archived) EXECUTE FUNCTION wake_session_archive_sidebar();
CREATE TRIGGER session_archive_sidebar_update AFTER UPDATE ON session_sidebar_preferences
  FOR EACH ROW WHEN (NEW.archived IS DISTINCT FROM OLD.archived) EXECUTE FUNCTION wake_session_archive_sidebar();
