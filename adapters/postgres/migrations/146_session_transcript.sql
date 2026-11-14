-- Transcript chunks use the existing idempotent connector event receipts as their durable payload.
CREATE UNIQUE INDEX agent_transcript_chunks ON agent_event_receipts
  (installation_id, (event->>'execution_id'), ((event#>>'{payload,transcript,position}')::integer),
   ((event#>>'{payload,transcript,part}')::integer))
  WHERE event->'payload' ? 'transcript';
CREATE INDEX agent_transcript_items ON agent_event_receipts
  (installation_id, (event->>'execution_id'), ((event#>>'{payload,transcript,position}')::integer))
  WHERE event#>>'{payload,transcript,last}' = 'true';
CREATE INDEX agent_transcript_revision ON agent_event_receipts
  (installation_id, (event->>'execution_id'), ((event->>'sequence')::integer) DESC)
  WHERE event#>>'{payload,transcript,last}' = 'true';
