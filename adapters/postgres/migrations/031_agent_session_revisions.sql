ALTER TABLE agent_sessions ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
