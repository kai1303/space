ALTER TABLE agent_sessions ADD COLUMN handoff_context jsonb;
ALTER TABLE agent_sessions ADD COLUMN handoff_hash text;
ALTER TABLE agent_sessions ADD CONSTRAINT handoff_shape CHECK (
  (handoff_context IS NULL AND handoff_hash IS NULL) OR
  (handoff_context IS NOT NULL AND handoff_hash IS NOT NULL AND managed AND created_by IS NOT NULL
    AND jsonb_typeof(handoff_context)='object' AND octet_length(handoff_context::text)<=28000)
);
CREATE INDEX sidekick_sessions_owner ON agent_sessions(workspace_id,created_by,created_at DESC,id DESC) WHERE handoff_context IS NOT NULL;
CREATE FUNCTION protect_sidekick_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND (NEW.handoff_context,NEW.handoff_hash) IS DISTINCT FROM (OLD.handoff_context,OLD.handoff_hash) THEN
    RAISE EXCEPTION 'handoff context is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.handoff_context IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM threads t JOIN channels c ON c.id=t.channel_id JOIN agent_installations i ON i.id=NEW.installation_id
    WHERE t.id=NEW.origin_thread_id AND c.kind='direct' AND c.direct_user_low=NEW.created_by AND c.direct_user_high=NEW.created_by
      AND i.owner_id=NEW.created_by AND i.workspace_id=NEW.workspace_id AND c.workspace_id=NEW.workspace_id
  ) THEN RAISE EXCEPTION 'handoff must belong to its owner' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER sidekick_session_boundary BEFORE INSERT OR UPDATE ON agent_sessions FOR EACH ROW EXECUTE FUNCTION protect_sidekick_session();
