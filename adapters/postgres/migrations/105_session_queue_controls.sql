ALTER TABLE agent_sessions ADD COLUMN queue_paused boolean NOT NULL DEFAULT false;
ALTER TABLE agent_session_inputs ADD COLUMN source_input_id uuid REFERENCES agent_session_inputs(id);
