ALTER TABLE outbound_connections ADD COLUMN kind text NOT NULL DEFAULT 'mcp'
  CHECK (kind IN ('mcp','people','knowledge'));
ALTER TABLE outbound_connections ADD CONSTRAINT workspace_knowledge_plugin
  CHECK ((kind='mcp' OR workspace_id IS NOT NULL)
    AND (kind<>'people' OR (url='space:people' AND auth_type='none' AND secret IS NULL)));
