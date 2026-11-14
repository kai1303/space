ALTER TABLE session_shared_outputs
  DROP CONSTRAINT session_shared_outputs_kind_check,
  ADD CONSTRAINT session_shared_outputs_kind_check CHECK (kind IN ('file', 'change', 'preview', 'view'));
