ALTER TABLE chat_delivery_outbox ADD COLUMN actor_id uuid;

CREATE OR REPLACE FUNCTION enqueue_chat_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; scope text := 'metadata'; resource uuid; actor uuid;
BEGIN
  data := coalesce(to_jsonb(NEW),to_jsonb(OLD));
  IF TG_TABLE_NAME='channel_events' OR TG_TABLE_NAME LIKE 'channel_events_p%' THEN
    scope := CASE data->>'type' WHEN 'task.event' THEN 'task' WHEN 'message.created' THEN 'message' ELSE 'none' END;
    resource := (data->'payload'->>'task_id')::uuid;
  ELSIF TG_TABLE_NAME='channel_reads' THEN
    scope := 'none'; actor := (data->>'user_id')::uuid;
  ELSIF TG_TABLE_NAME IN ('human_credentials','auth_sessions') THEN
    scope := 'none'; actor := (data->>'user_id')::uuid;
  END IF;
  INSERT INTO chat_delivery_outbox(channel_id,workspace_id,resource_scope,resource_id,actor_id)
    VALUES ((data->>'channel_id')::uuid,(data->>'workspace_id')::uuid,scope,resource,actor);
  RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION enqueue_stream_chat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace uuid; keys text[] := '{}';
BEGIN
  workspace := coalesce(NEW.workspace_id,(SELECT workspace_id FROM channels WHERE id=NEW.channel_id));
  IF NEW.channel_id IS NOT NULL THEN keys := array_append(keys,'channel-events:' || NEW.channel_id); END IF;
  IF NEW.actor_id IS NOT NULL THEN
    keys := array_append(keys,CASE WHEN NEW.channel_id IS NULL THEN 'actor:' || NEW.actor_id
      ELSE 'unread-user:' || workspace || ':' || NEW.actor_id END);
  ELSIF NEW.resource_scope IN ('task','thread') THEN
    IF NEW.resource_id IS NOT NULL THEN keys := array_append(keys,NEW.resource_scope || ':' || NEW.resource_id); END IF;
  ELSIF NEW.resource_scope='message' THEN
    keys := keys || ARRAY['workspace-messages:' || workspace,'unread:' || workspace];
  ELSIF NEW.resource_scope<>'none' THEN
    keys := array_append(keys,coalesce('workspace:' || workspace,'global'));
    IF NEW.channel_id IS NOT NULL THEN keys := array_append(keys,'channel:' || NEW.channel_id); END IF;
  END IF;
  INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('chat.changed',coalesce(NEW.channel_id::text,'all'),
    jsonb_build_object('channel_id',NEW.channel_id,'workspace_id',workspace,'resource_scope',NEW.resource_scope,
      'resource_id',NEW.resource_id,'actor_id',NEW.actor_id,'keys',keys,'chat_delivery_id',NEW.id::text));
  RETURN NULL;
END; $$;
