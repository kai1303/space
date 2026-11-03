-- A null thread scope retains the original opt-in channel-memory credential semantics.
ALTER TABLE memory_connections ADD COLUMN thread_id uuid REFERENCES threads(id) ON DELETE CASCADE;
CREATE TABLE thread_checkpoints (
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  through_sequence bigint NOT NULL CHECK (through_sequence > 0),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 6000),
  source_message_ids uuid[] NOT NULL CHECK (cardinality(source_message_ids) BETWEEN 1 AND 32),
  producer_id uuid NOT NULL,
  producer_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, revision)
);
CREATE INDEX thread_checkpoints_snapshot ON thread_checkpoints(thread_id, through_sequence DESC, revision DESC);
