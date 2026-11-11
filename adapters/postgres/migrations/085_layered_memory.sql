-- Layered short-term memory: thread and session checkpoints share one table.
ALTER TABLE thread_checkpoints ADD COLUMN session_id uuid REFERENCES agent_sessions(id) ON DELETE CASCADE;
ALTER TABLE thread_checkpoints ADD COLUMN channel_id uuid REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE thread_checkpoints ADD COLUMN summary text;
UPDATE thread_checkpoints cp SET channel_id = t.channel_id FROM threads t WHERE t.id = cp.thread_id;
UPDATE thread_checkpoints SET summary = left(btrim(split_part(btrim(content), E'\n\n', 1)), 280);
ALTER TABLE thread_checkpoints ALTER COLUMN channel_id SET NOT NULL;
ALTER TABLE thread_checkpoints ALTER COLUMN summary SET NOT NULL;
ALTER TABLE thread_checkpoints ADD CONSTRAINT thread_checkpoints_summary CHECK (length(btrim(summary)) BETWEEN 1 AND 280);
ALTER TABLE thread_checkpoints DROP CONSTRAINT thread_checkpoints_pkey;
CREATE UNIQUE INDEX thread_checkpoints_thread_revision ON thread_checkpoints(thread_id, revision) WHERE session_id IS NULL;
CREATE UNIQUE INDEX thread_checkpoints_session_revision ON thread_checkpoints(session_id, revision) WHERE session_id IS NOT NULL;
DROP INDEX thread_checkpoints_snapshot;
CREATE INDEX thread_checkpoints_snapshot ON thread_checkpoints(thread_id, through_sequence DESC, revision DESC) WHERE session_id IS NULL;
CREATE INDEX thread_checkpoints_session_snapshot ON thread_checkpoints(session_id, through_sequence DESC, revision DESC) WHERE session_id IS NOT NULL;
CREATE INDEX thread_checkpoints_channel_recent ON thread_checkpoints(channel_id, created_at DESC) WHERE session_id IS NULL;
