ALTER TABLE tasks ADD COLUMN goal_action jsonb CHECK (goal_action IS NULL OR skill IN ('codex.run','claude.run'));
ALTER TABLE agent_sessions ADD COLUMN session_goal jsonb;
