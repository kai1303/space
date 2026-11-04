ALTER TABLE mention_preferences
  ADD COLUMN mode text NOT NULL DEFAULT 'mentions' CHECK(mode IN ('mentions','all','none')),
  ADD COLUMN desktop_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN preview_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN thread_replies boolean NOT NULL DEFAULT true;

CREATE TABLE notification_subscriptions (
  thread_id uuid NOT NULL REFERENCES threads(id),
  user_id uuid NOT NULL REFERENCES users(id),
  following boolean NOT NULL DEFAULT true,
  PRIMARY KEY(thread_id,user_id)
);
-- Existing participation follows the same rule as new messages. Future automatic
-- inserts never overwrite explicit unfollows.
INSERT INTO notification_subscriptions(thread_id,user_id)
  SELECT DISTINCT thread_id,user_id FROM messages WHERE author_type='human' AND user_id IS NOT NULL
  ON CONFLICT DO NOTHING;
INSERT INTO notification_subscriptions(thread_id,user_id)
  SELECT DISTINCT m.thread_id,n.user_id FROM mention_notifications n
  JOIN messages m ON m.channel_id=n.channel_id AND m.id=n.message_id
  JOIN workspace_members wm ON wm.workspace_id=n.workspace_id AND wm.user_id=n.user_id AND wm.active
  JOIN channel_members cm ON cm.channel_id=n.channel_id AND cm.user_id=n.user_id
  ON CONFLICT DO NOTHING;

CREATE TABLE notification_heads (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(workspace_id,user_id)
);
CREATE SEQUENCE notifications_id_seq;
CREATE TABLE notifications (
  id bigint PRIMARY KEY,
  workspace_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  message_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('mention','direct_message','thread_reply','reaction','channel_message')),
  emoji text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  silent boolean NOT NULL DEFAULT false,
  claimed_at timestamptz,
  CHECK((kind='reaction')=(emoji IS NOT NULL)),
  FOREIGN KEY(channel_id,message_id) REFERENCES messages(channel_id,id),
  FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id)
);
CREATE UNIQUE INDEX notification_message_recipient ON notifications(message_id,user_id) WHERE kind<>'reaction';
CREATE UNIQUE INDEX notification_reaction_recipient ON notifications(message_id,user_id,actor_id,emoji) WHERE kind='reaction';
CREATE INDEX notifications_inbox ON notifications(user_id,workspace_id,id DESC);
CREATE INDEX notifications_unread ON notifications(user_id,workspace_id,id DESC) WHERE read_at IS NULL;
ALTER SEQUENCE notifications_id_seq OWNED BY notifications.id;
-- Serialize each recipient's durable feed through an atomic revision write before
-- allocating an ID. A later commit cannot appear below an already-seen watermark.
-- PostgreSQL's normal row write locks still apply; there are no explicit locks.
CREATE FUNCTION order_notification_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO notification_heads(workspace_id,user_id) VALUES(NEW.workspace_id,NEW.user_id)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET revision=notification_heads.revision+1;
  NEW.id := nextval('notifications_id_seq');
  RETURN NEW;
END; $$;
CREATE TRIGGER notifications_order_insert BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION order_notification_insert();
INSERT INTO notifications(workspace_id,channel_id,message_id,user_id,actor_id,kind,created_at,read_at,silent)
  SELECT n.workspace_id,n.channel_id,n.message_id,n.user_id,m.user_id,'mention',n.created_at,n.read_at,n.silent
  FROM mention_notifications n JOIN messages m ON m.channel_id=n.channel_id AND m.id=n.message_id
  JOIN workspace_members wm ON wm.workspace_id=n.workspace_id AND wm.user_id=n.user_id AND wm.active
  JOIN channel_members cm ON cm.channel_id=n.channel_id AND cm.user_id=n.user_id
  WHERE m.user_id IS NOT NULL AND m.user_id<>n.user_id ORDER BY n.id;

-- Claims affect only transient delivery; they must not refresh Activity again.
CREATE TRIGGER notifications_resource_insert AFTER INSERT OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
CREATE TRIGGER notifications_resource_read AFTER UPDATE OF read_at ON notifications
  FOR EACH ROW WHEN (NEW.read_at IS DISTINCT FROM OLD.read_at) EXECUTE FUNCTION enqueue_resource_delivery();
CREATE FUNCTION enqueue_notification_subscription() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND NEW.following=OLD.following THEN RETURN NULL; END IF;
  INSERT INTO chat_delivery_outbox(channel_id,workspace_id,resource_scope,resource_id)
    SELECT channel_id,workspace_id,'thread',id FROM threads WHERE id=NEW.thread_id;
  RETURN NULL;
END; $$;
CREATE TRIGGER notification_subscription_delivery AFTER INSERT OR UPDATE ON notification_subscriptions
  FOR EACH ROW EXECUTE FUNCTION enqueue_notification_subscription();

-- Keep existing mention clients coherent with Activity. The distinct predicates
-- stop the reverse trigger without suppressing either table's durable invalidation.
CREATE FUNCTION synchronize_mention_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_TABLE_NAME='notifications' THEN
    UPDATE mention_notifications SET read_at=NEW.read_at
      WHERE message_id=NEW.message_id AND user_id=NEW.user_id AND read_at IS DISTINCT FROM NEW.read_at;
  ELSE
    UPDATE notifications SET read_at=NEW.read_at
      WHERE message_id=NEW.message_id AND user_id=NEW.user_id AND kind='mention' AND read_at IS DISTINCT FROM NEW.read_at;
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER notifications_mention_read AFTER UPDATE OF read_at ON notifications
  FOR EACH ROW WHEN (NEW.kind='mention' AND NEW.read_at IS DISTINCT FROM OLD.read_at) EXECUTE FUNCTION synchronize_mention_read();
CREATE TRIGGER mentions_activity_read AFTER UPDATE OF read_at ON mention_notifications
  FOR EACH ROW WHEN (NEW.read_at IS DISTINCT FROM OLD.read_at) EXECUTE FUNCTION synchronize_mention_read();
