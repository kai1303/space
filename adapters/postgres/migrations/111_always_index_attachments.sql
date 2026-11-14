CREATE OR REPLACE VIEW graph_source_attachments WITH (security_barrier=true) AS
 SELECT a.id, m.workspace_id, m.channel_id, m.thread_id, m.id AS message_id, a.name, a.type, a.size
 FROM channels c
 JOIN assets a ON (a.workspace_id,a.channel_id)=(c.workspace_id,c.id)
 JOIN messages m ON (m.workspace_id,m.channel_id,m.id)=(a.workspace_id,a.channel_id,a.message_id)
 WHERE c.kind='channel' AND c.archived_at IS NULL AND m.author_type='human' AND m.agent_session_id IS NULL
 AND m.deleted_at IS NULL AND m.retained_at IS NULL AND a.status='ready' AND NOT a.encrypted
 AND m.attachments @> jsonb_build_array(jsonb_build_object('id',a.id));

DROP TABLE knowledge_attachment_channels;
