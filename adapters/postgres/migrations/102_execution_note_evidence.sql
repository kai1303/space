-- Bound to the prepared execution. Space rechecks channel and message visibility before saving a note.
CREATE TABLE execution_note_evidence (
  execution_id uuid PRIMARY KEY REFERENCES executions(id) ON DELETE CASCADE,
  message_id uuid,
  revision bigint
);
