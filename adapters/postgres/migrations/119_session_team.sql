CREATE TABLE session_reviewers (
  workspace_id uuid NOT NULL, session_id uuid NOT NULL, user_id uuid NOT NULL,
  PRIMARY KEY(session_id,user_id),
  FOREIGN KEY(workspace_id,session_id) REFERENCES agent_sessions(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE
);
CREATE INDEX session_reviewers_member ON session_reviewers(workspace_id,user_id,session_id);

CREATE TABLE session_team_visibility (
  workspace_id uuid NOT NULL, session_id uuid PRIMARY KEY,
  FOREIGN KEY(workspace_id,session_id) REFERENCES agent_sessions(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX session_team_visibility_workspace ON session_team_visibility(workspace_id,session_id);

CREATE TABLE session_discussion_messages (
  session_id uuid NOT NULL REFERENCES agent_sessions ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users, client_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY, created_at timestamptz NOT NULL DEFAULT now(),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  PRIMARY KEY(session_id,actor_id,client_id), UNIQUE(session_id,sequence)
);

CREATE TABLE session_shared_outputs (
  session_id uuid NOT NULL REFERENCES agent_sessions ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('file','change','preview')), path text NOT NULL,
  output jsonb NOT NULL,
  PRIMARY KEY(session_id,kind,path)
);

CREATE FUNCTION session_team_access(sid uuid, actor uuid)
RETURNS TABLE(workspace_id uuid, title text, can_manage boolean, writable boolean, workspace_visible boolean)
LANGUAGE sql STABLE AS $$
  SELECT a.workspace_id,a.title,
    cm.user_id IS NOT NULL AND m.guest_type='none' AND (a.created_by=actor OR i.owner_id=actor),
    a.state='active' AND ch.archived_at IS NULL, v.session_id IS NOT NULL
  FROM agent_sessions a
  JOIN threads t ON t.id=a.origin_thread_id JOIN channels ch ON ch.id=t.channel_id
  JOIN workspace_members m ON m.workspace_id=a.workspace_id AND m.user_id=actor AND m.active
  JOIN agent_installations i ON i.id=a.installation_id
  LEFT JOIN channel_members cm ON cm.channel_id=ch.id AND cm.user_id=actor
  LEFT JOIN session_team_visibility v ON v.session_id=a.id
  LEFT JOIN session_reviewers r ON r.session_id=a.id AND r.user_id=actor
  WHERE a.id=sid AND a.managed AND a.handoff_context IS NULL
    AND (cm.user_id IS NOT NULL OR ((r.user_id IS NOT NULL OR v.session_id IS NOT NULL) AND m.guest_type='none'))
$$;

-- Only a revision and audience keys travel on the bus. The HTTP read authorizes every snapshot.
CREATE FUNCTION deliver_session_team_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid := COALESCE(NEW.session_id,OLD.session_id); rkey text := 'session-team:' || sid; keys text[] := ARRAY[rkey];
BEGIN
  INSERT INTO resource_update_revisions(resource) VALUES(rkey)
    ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
  INSERT INTO event_outbox(kind,aggregate_id,payload)
    VALUES('chat.changed',sid::text,jsonb_build_object('keys',jsonb_build_array(rkey)));
  IF TG_TABLE_NAME IN ('session_reviewers','session_team_visibility') THEN
    INSERT INTO chat_delivery_outbox(workspace_id) VALUES(COALESCE(NEW.workspace_id,OLD.workspace_id));
    keys := array_append(keys,'workspace:' || COALESCE(NEW.workspace_id,OLD.workspace_id));
  END IF;
  PERFORM pg_notify('space_direct_turn',json_build_object('keys',keys)::text);
  RETURN NULL;
END; $$;
CREATE TRIGGER session_discussion_delivery AFTER INSERT ON session_discussion_messages FOR EACH ROW EXECUTE FUNCTION deliver_session_team_change();
CREATE TRIGGER session_reviewers_delivery AFTER INSERT OR DELETE ON session_reviewers FOR EACH ROW EXECUTE FUNCTION deliver_session_team_change();
CREATE TRIGGER session_team_visibility_delivery AFTER INSERT OR DELETE ON session_team_visibility FOR EACH ROW EXECUTE FUNCTION deliver_session_team_change();
CREATE TRIGGER session_shared_outputs_delivery AFTER INSERT OR UPDATE OR DELETE ON session_shared_outputs FOR EACH ROW EXECUTE FUNCTION deliver_session_team_change();

CREATE FUNCTION clear_session_review_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM session_reviewers WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id;
  RETURN NULL;
END; $$;
CREATE TRIGGER revoke_session_reviews AFTER UPDATE OF active,guest_type ON workspace_members
  FOR EACH ROW WHEN (NOT NEW.active OR NEW.guest_type<>'none') EXECUTE FUNCTION clear_session_review_grants();
