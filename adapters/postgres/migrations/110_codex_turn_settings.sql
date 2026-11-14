ALTER TABLE tasks ADD COLUMN codex_settings jsonb
  CHECK (codex_settings IS NULL OR (skill = 'codex.run' AND jsonb_typeof(codex_settings) = 'object'));
