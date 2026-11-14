-- Space validates provider membership against its shipped catalog before writing.
-- Retain the descriptor binding and allow historical pairings without a snapshot.
ALTER TABLE agent_pairings DROP CONSTRAINT agent_pairings_provider_check,
  ADD CONSTRAINT agent_pairings_provider_check CHECK (
    provider IS NULL OR (
      provider ~ '^[a-z][a-z0-9_-]{0,63}$'
      AND (descriptor IS NULL OR (descriptor->>'provider') IS NOT DISTINCT FROM provider)
    )
  );

ALTER TABLE tasks DROP CONSTRAINT tasks_codex_settings_check,
  ADD CONSTRAINT tasks_codex_settings_check CHECK (
    codex_settings IS NULL OR jsonb_typeof(codex_settings) = 'object'
  );
