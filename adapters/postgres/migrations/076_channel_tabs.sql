-- Index the source rows so old shares and thread replies are discoverable without replaying history.
CREATE FUNCTION channel_shared_urls(body text, doc jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY(SELECT DISTINCT url FROM (
    SELECT regexp_replace(rtrim((hit)[1], '.,;:!?'), '\)$', CASE WHEN length((hit)[1])-length(replace((hit)[1],')','')) > length((hit)[1])-length(replace((hit)[1],'(','')) THEN '' ELSE ')' END) AS url FROM regexp_matches(body, '(https?://[^[:space:]<>"\x27]+)', 'gi') hit
    UNION ALL
    SELECT op->'attributes'->>'link' FROM jsonb_array_elements(doc->'ops') op
  ) candidates WHERE url ~* '^https?://[^/[:space:]<>]+'
    AND length(url) <= 2048 ORDER BY url)
$$;

CREATE INDEX channel_links_by_sequence ON messages(channel_id,sequence DESC)
  WHERE deleted_at IS NULL AND retained_at IS NULL AND agent_session_id IS NULL
    AND cardinality(channel_shared_urls(text,document)) > 0;
CREATE INDEX channel_files_by_sequence ON messages(channel_id,sequence DESC)
  WHERE deleted_at IS NULL AND retained_at IS NULL AND agent_session_id IS NULL AND attachments <> '[]';

CREATE TABLE channel_tab_visibility (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  tab text NOT NULL CHECK (tab IN ('files','pins','memory','navigator')),
  visible boolean NOT NULL,
  PRIMARY KEY (channel_id,tab)
);
CREATE TRIGGER channel_tab_visibility_changed AFTER INSERT OR DELETE OR UPDATE ON channel_tab_visibility
  FOR EACH ROW EXECUTE FUNCTION enqueue_chat_delivery();

CREATE FUNCTION notify_channel_shares() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.agent_session_id IS NULL AND OLD.deleted_at IS NULL AND OLD.retained_at IS NULL
      AND (OLD.attachments <> '[]' OR cardinality(channel_shared_urls(OLD.text,OLD.document)) > 0) THEN
    INSERT INTO chat_delivery_outbox(channel_id,workspace_id) VALUES (OLD.channel_id,OLD.workspace_id);
  ELSIF TG_OP <> 'DELETE' AND NEW.agent_session_id IS NULL AND NEW.deleted_at IS NULL AND NEW.retained_at IS NULL
      AND (NEW.attachments <> '[]' OR cardinality(channel_shared_urls(NEW.text,NEW.document)) > 0) THEN
    INSERT INTO chat_delivery_outbox(channel_id,workspace_id) VALUES (NEW.channel_id,NEW.workspace_id);
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER channel_shares_changed AFTER INSERT OR DELETE OR UPDATE OF text,document,attachments,deleted_at,retained_at,agent_session_id ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_channel_shares();
