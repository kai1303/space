-- Remember the last provider name so reopening a thread preserves local renames.
ALTER TABLE agent_sessions ADD COLUMN codex_title text
  CHECK (char_length(codex_title) BETWEEN 1 AND 160);
