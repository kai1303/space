CREATE TABLE session_message_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  part text NOT NULL CHECK (part IN ('request','response')),
  edited_text text, deleted_at timestamptz, pinned boolean NOT NULL DEFAULT false,
  UNIQUE(task_id,part)
);
CREATE INDEX session_pinned_messages ON session_message_state(task_id,id) WHERE pinned AND deleted_at IS NULL;
CREATE TABLE session_message_reactions (
  message_id uuid NOT NULL REFERENCES session_message_state ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users, emoji text NOT NULL,
  PRIMARY KEY(message_id,user_id,emoji)
);
CREATE TABLE session_message_preferences (
  message_id uuid NOT NULL REFERENCES session_message_state ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users, saved_at timestamptz, unread boolean NOT NULL DEFAULT false,
  following boolean NOT NULL DEFAULT true, PRIMARY KEY(message_id,user_id)
);
CREATE INDEX session_saved_owner ON session_message_preferences(user_id,saved_at DESC,message_id) WHERE saved_at IS NOT NULL;
CREATE TABLE session_message_replies (
  id uuid PRIMARY KEY, message_id uuid NOT NULL REFERENCES session_message_state ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_reply_order ON session_message_replies(message_id,created_at,id);
CREATE VIEW session_saved_items AS
  SELECT s.id,t.workspace_id,th.channel_id,t.thread_id,a.id AS session_id,t.id AS task_id,s.part,
    p.user_id AS viewer,p.saved_at,t.created_at,a.title AS channel_name,
    CASE WHEN s.part='request' THEN u.display_name ELSE coalesce(ac.name,d.name,'Agent') END AS author_name,
    coalesce(s.edited_text,CASE WHEN s.part='request' THEN t.goal ELSE t.result END,'Agent response') AS text
  FROM session_message_preferences p JOIN session_message_state s ON s.id=p.message_id
  JOIN tasks t ON t.id=s.task_id JOIN agent_sessions a ON a.id=t.session_id JOIN threads th ON th.id=a.origin_thread_id
  JOIN users u ON u.id=t.requester_id JOIN agent_installations i ON i.id=a.installation_id
  JOIN agent_definitions d ON d.id=i.definition_id LEFT JOIN agent_connections ac ON ac.installation_id=i.id
  WHERE p.saved_at IS NOT NULL AND s.deleted_at IS NULL AND (a.handoff_context IS NULL OR a.created_by=p.user_id);
