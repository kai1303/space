-- Page only human inputs that shared something, including messages from earlier releases.
CREATE INDEX task_shared_resources ON tasks(session_id,created_at DESC,id DESC)
  WHERE session_id IS NOT NULL AND (attachments <> '[]' OR cardinality(channel_shared_urls(goal, request_document)) > 0);
CREATE INDEX steer_shared_resources ON agent_session_inputs(session_id,created_at DESC,id DESC)
  WHERE kind='steer' AND state='sent' AND cardinality(channel_shared_urls(body->>'text',body->'document')) > 0;
