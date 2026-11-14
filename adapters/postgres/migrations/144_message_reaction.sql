-- Execute the reaction, its notification and its replay event in one database call.
-- Uncontended retries skip sequence allocation. Build the message payload once.
CREATE FUNCTION apply_message_reaction(actor uuid, channel uuid, target uuid, symbol text, active boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  item messages%ROWTYPE;
  initial record;
  seq bigint;
  changed boolean := false;
  payload jsonb;
  summary jsonb;
BEGIN
  SELECT ch.archived_at IS NOT NULL AS archived,
      EXISTS(SELECT 1 FROM message_reactions WHERE channel_id=channel AND message_id=target AND user_id=actor AND emoji=symbol) AS present
    INTO initial
    FROM channels ch JOIN messages m ON m.channel_id=ch.id AND m.id=target
    JOIN channel_members cm ON cm.workspace_id=ch.workspace_id AND cm.channel_id=ch.id AND cm.user_id=actor
    JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=actor AND wm.active
    WHERE ch.id=channel AND m.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='SP404', MESSAGE='not_found'; END IF;
  IF initial.archived THEN RAISE EXCEPTION USING ERRCODE='SP409', MESSAGE='channel_archived'; END IF;

  IF initial.present <> active THEN
    UPDATE channels SET event_sequence=event_sequence+1
      WHERE id=channel AND archived_at IS NULL RETURNING event_sequence INTO seq;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='SP409', MESSAGE='channel_archived'; END IF;
    -- Competing toggles may have committed while the sequence update waited.
    IF active THEN
      INSERT INTO message_reactions(channel_id,message_id,user_id,emoji) VALUES(channel,target,actor,symbol)
        ON CONFLICT DO NOTHING;
    ELSE
      DELETE FROM message_reactions WHERE channel_id=channel AND message_id=target AND user_id=actor AND emoji=symbol;
    END IF;
    changed := FOUND;
    IF changed THEN
      UPDATE messages SET reaction_sequence=seq WHERE channel_id=channel AND id=target AND deleted_at IS NULL RETURNING * INTO item;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='SP404', MESSAGE='not_found'; END IF;
      IF active AND item.author_type='human' AND item.user_id<>actor THEN
        INSERT INTO notifications(workspace_id,channel_id,message_id,user_id,actor_id,kind,emoji,silent)
          SELECT item.workspace_id,channel,target,item.user_id,actor,'reaction',symbol,
            coalesce(p.paused_until>now(),false) OR coalesce(cm.muted_until>now(),false) OR coalesce(cm.notification_mode,p.mode,'mentions')='none'
          FROM channel_members cm JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=cm.user_id AND wm.active
          LEFT JOIN mention_preferences p ON p.user_id=cm.user_id
          WHERE cm.workspace_id=item.workspace_id AND cm.channel_id=channel AND cm.user_id=item.user_id
          ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END IF;
  -- Read the revision, reactions and reply summary from one snapshot, including on retries.
  SELECT chat_message_payload(m),
      CASE WHEN ch.encrypted_since IS NULL AND m.agent_session_id IS NULL
        THEN chat_reply_summary(m.workspace_id,channel,m.thread_id) END
    INTO payload,summary
    FROM messages m JOIN channels ch ON ch.id=m.channel_id
    JOIN channel_members cm ON cm.channel_id=ch.id AND cm.workspace_id=ch.workspace_id AND cm.user_id=actor
    JOIN workspace_members wm ON wm.workspace_id=cm.workspace_id AND wm.user_id=actor AND wm.active
    WHERE m.channel_id=channel AND m.id=target AND m.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='SP404', MESSAGE='not_found'; END IF;
  IF changed THEN
    INSERT INTO channel_events(workspace_id,channel_id,thread_id,sequence,type,payload)
      VALUES(item.workspace_id,channel,item.thread_id,seq,'message.updated',payload);
  END IF;
  IF summary IS NOT NULL THEN
    payload := payload || jsonb_build_object('reply_summary',summary,'reply_count',summary->'count');
  END IF;
  RETURN payload;
END; $$;
