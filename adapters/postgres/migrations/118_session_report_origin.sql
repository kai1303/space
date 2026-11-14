CREATE INDEX session_report_origin ON navigator_authorizations(session_id, thread_id, created_at)
  INCLUDE (source_message_id) WHERE action='start';
