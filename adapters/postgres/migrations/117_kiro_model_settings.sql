ALTER TABLE tasks DROP CONSTRAINT tasks_codex_settings_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_codex_settings_check CHECK
  (codex_settings IS NULL OR (skill IN ('codex.run','claude.run','kiro.run') AND jsonb_typeof(codex_settings) = 'object'));
