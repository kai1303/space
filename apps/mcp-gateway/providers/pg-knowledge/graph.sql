-- Apply once after schema.sql and threads.sql, as the owner of schema kb. Graph metadata holds source identifiers only.
BEGIN;
CREATE TABLE kb.g_channels (
  id text PRIMARY KEY, workspace_id uuid NOT NULL, name text NOT NULL,
  is_private boolean NOT NULL, enabled boolean NOT NULL DEFAULT false, version bigint NOT NULL
);
CREATE TABLE kb.g_threads (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  channel_id text NOT NULL REFERENCES kb.g_channels(id) ON DELETE CASCADE, version bigint NOT NULL
);
CREATE TABLE kb.g_sessions (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  thread_id text NOT NULL REFERENCES kb.g_threads(id) ON DELETE CASCADE,
  title text NOT NULL, state text NOT NULL, version bigint NOT NULL
);
CREATE TABLE kb.g_knowledge (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  channel_id text NOT NULL REFERENCES kb.g_channels(id) ON DELETE CASCADE,
  kind text NOT NULL, title text NOT NULL, revision integer NOT NULL, version bigint NOT NULL
);
CREATE TABLE kb.g_evidence (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  knowledge_id text NOT NULL REFERENCES kb.g_knowledge(id) ON DELETE CASCADE,
  thread_id text NOT NULL REFERENCES kb.g_threads(id) ON DELETE CASCADE
);
CREATE INDEX ON kb.g_threads(channel_id);
CREATE INDEX ON kb.g_sessions(thread_id);
CREATE INDEX ON kb.g_knowledge(workspace_id, channel_id);
CREATE INDEX ON kb.g_evidence(thread_id);
CREATE INDEX ON kb.g_evidence(knowledge_id);
-- lsn: last transaction applied. published_lsn: last position the pgGraph graph was built at.
CREATE TABLE kb.graph_position (
  slot text PRIMARY KEY, lsn pg_lsn NOT NULL, published_lsn pg_lsn NOT NULL DEFAULT '0/0'
);
GRANT SELECT ON kb.g_channels, kb.g_threads, kb.g_sessions, kb.g_knowledge, kb.g_evidence TO space_knowledge_reader;
SELECT graph.create_graph('space_knowledge');
SELECT graph.add_table_to_graph('space_knowledge','kb.g_channels'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_knowledge','kb.g_threads'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_knowledge','kb.g_sessions'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_knowledge','kb.g_knowledge'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_knowledge','kb.g_evidence'::regclass,'id',ARRAY['id']);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_threads'::regclass,'channel_id','kb.g_channels'::regclass,'id',
  label := 'in_channel', bidirectional := false);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_sessions'::regclass,'thread_id','kb.g_threads'::regclass,'id',
  label := 'of_thread', bidirectional := false);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_knowledge'::regclass,'channel_id','kb.g_channels'::regclass,'id',
  label := 'in_channel', bidirectional := false);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_evidence'::regclass,'knowledge_id','kb.g_knowledge'::regclass,'id',
  label := 'supports', bidirectional := false);
SELECT graph.add_edge_to_graph('space_knowledge','kb.g_evidence'::regclass,'thread_id','kb.g_threads'::regclass,'id',
  label := 'from_thread', bidirectional := false);
SELECT graph.grant_graph('space_knowledge','space_knowledge_reader','read');
COMMIT;
SELECT * FROM graph.build_graph('space_knowledge', true);
