ALTER TABLE outbound_connections DROP CONSTRAINT outbound_connections_kind_check,
  ADD CHECK (kind IN ('mcp','people','channels','knowledge')),
  ADD CONSTRAINT channel_directory_endpoint CHECK (
    kind <> 'channels' OR (workspace_id IS NOT NULL AND url='space:channels' AND auth_type='none' AND secret IS NULL)
  );
