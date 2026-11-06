ALTER TABLE agent_pairings DROP CONSTRAINT agent_pairings_provider_check;
ALTER TABLE agent_pairings ADD CONSTRAINT agent_pairings_provider_check CHECK (provider IN ('codex','kiro','claude'));
