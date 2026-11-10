-- Retain the creation request title on first rename for idempotent creation retries.
ALTER TABLE agent_sessions ADD COLUMN creation_title text;
