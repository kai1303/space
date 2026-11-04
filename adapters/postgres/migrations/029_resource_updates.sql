-- Keep committed revisions after the delivery outbox is drained, so API instances can
-- repair a missed Redis hint without making idle browsers refetch their resources.
ALTER TABLE chat_delivery_outbox ADD COLUMN workspace_id uuid;
ALTER TABLE chat_delivery_outbox ADD COLUMN resource_scope text NOT NULL DEFAULT 'metadata';
ALTER TABLE chat_delivery_outbox ADD COLUMN resource_id uuid;
CREATE TABLE resource_update_revisions (
  resource text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1
);
CREATE FUNCTION advance_resource_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace uuid;
BEGIN
  workspace := coalesce(NEW.workspace_id,(SELECT workspace_id FROM channels WHERE id=NEW.channel_id));
  IF NEW.resource_scope='none' THEN RETURN NULL; END IF;
  IF NEW.resource_scope IN ('task','thread') THEN
    IF NEW.resource_id IS NOT NULL THEN
      INSERT INTO resource_update_revisions(resource) VALUES(NEW.resource_scope || ':' || NEW.resource_id)
        ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.resource_scope='message' THEN
    INSERT INTO resource_update_revisions(resource) VALUES('workspace-messages:' || workspace)
      ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
    RETURN NULL;
  END IF;
  IF NEW.channel_id IS NOT NULL THEN
    INSERT INTO resource_update_revisions(resource) VALUES('channel:' || NEW.channel_id)
      ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
  END IF;
  INSERT INTO resource_update_revisions(resource) VALUES(coalesce('workspace:' || workspace,'global'))
    ON CONFLICT(resource) DO UPDATE SET revision=resource_update_revisions.revision+1;
  RETURN NULL;
END; $$;
CREATE TRIGGER chat_delivery_revisions AFTER INSERT ON chat_delivery_outbox
  FOR EACH ROW EXECUTE FUNCTION advance_resource_revision();

CREATE OR REPLACE FUNCTION enqueue_chat_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; scope text := 'metadata'; resource uuid;
BEGIN
  data := coalesce(to_jsonb(NEW),to_jsonb(OLD));
  IF TG_TABLE_NAME='channel_events' OR TG_TABLE_NAME LIKE 'channel_events_p%' THEN
    scope := CASE data->>'type' WHEN 'task.event' THEN 'task' WHEN 'message.created' THEN 'message' ELSE 'none' END;
    resource := (data->'payload'->>'task_id')::uuid;
  ELSIF TG_TABLE_NAME='channel_reads' THEN scope := 'none';
  END IF;
  INSERT INTO chat_delivery_outbox(channel_id,workspace_id,resource_scope,resource_id)
    VALUES ((data->>'channel_id')::uuid,(data->>'workspace_id')::uuid,scope,resource);
  RETURN NULL;
END; $$;
DROP TRIGGER workspace_members_delivery ON workspace_members;
CREATE TRIGGER workspace_members_delivery AFTER INSERT OR UPDATE OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION enqueue_chat_delivery();

CREATE FUNCTION enqueue_resource_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; channel uuid; workspace uuid; person uuid; installation uuid; scope text := 'metadata'; resource uuid;
BEGIN
  data := coalesce(to_jsonb(NEW),to_jsonb(OLD));
  IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='channels' THEN
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'event_sequence')=(to_jsonb(OLD)-'event_sequence') THEN RETURN NULL; END IF;
    channel := (data->>'id')::uuid;
  ELSIF TG_TABLE_NAME='agent_connections' THEN
    -- Heartbeats extend liveness; only a visible status/connection change wakes the UI.
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'last_seen_at')=(to_jsonb(OLD)-'last_seen_at') THEN RETURN NULL; END IF;
    installation := (data->>'installation_id')::uuid;
    SELECT workspace_id INTO workspace FROM agent_installations WHERE id=installation;
  ELSIF TG_TABLE_NAME IN ('users','mention_preferences') THEN
    person := (data->>CASE WHEN TG_TABLE_NAME='users' THEN 'id' ELSE 'user_id' END)::uuid;
    INSERT INTO chat_delivery_outbox(workspace_id)
      SELECT workspace_id FROM workspace_members WHERE user_id=person ORDER BY workspace_id;
    RETURN NULL;
  ELSIF TG_TABLE_NAME='agent_definitions' THEN
    INSERT INTO chat_delivery_outbox(workspace_id)
      SELECT DISTINCT workspace_id FROM agent_installations WHERE definition_id=(data->>'id')::uuid ORDER BY workspace_id;
    RETURN NULL;
  ELSE
    channel := (data->>'channel_id')::uuid;
    IF TG_TABLE_NAME='agent_thread_subscriptions' THEN
      SELECT channel_id INTO channel FROM threads WHERE id=(data->>'thread_id')::uuid;
      scope := 'thread'; resource := (data->>'thread_id')::uuid;
    END IF;
  END IF;
  workspace := coalesce(workspace,(data->>'workspace_id')::uuid,(SELECT workspace_id FROM channels WHERE id=channel));
  INSERT INTO chat_delivery_outbox(channel_id,workspace_id,resource_scope,resource_id) VALUES(channel,workspace,scope,resource);
  RETURN NULL;
END; $$;
CREATE TRIGGER channels_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON channels
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER users_resource_delivery AFTER UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER mention_preferences_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON mention_preferences
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
-- Message insertion already has one durable channel-event hint in the same transaction.
CREATE TRIGGER mention_notifications_resource_delivery AFTER UPDATE OR DELETE ON mention_notifications
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER workspace_mention_settings_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON workspace_mention_settings
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER navigator_suggestions_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON navigator_suggestions
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER navigator_settings_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON navigator_settings
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER agent_thread_subscriptions_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON agent_thread_subscriptions
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER agent_pairings_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON agent_pairings
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER agent_connections_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON agent_connections
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER agent_installations_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON agent_installations
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER agent_definitions_resource_delivery AFTER UPDATE OR DELETE ON agent_definitions
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER agent_grants_resource_delivery AFTER INSERT OR UPDATE OR DELETE ON agent_grants
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER workspaces_resource_delivery AFTER UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
