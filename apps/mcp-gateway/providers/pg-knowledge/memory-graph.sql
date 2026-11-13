-- Apply once after schema.sql, as the owner of schema kb. One graph for memory and knowledge.
-- Message text and vectors live here; Space decides who may read them (memory_visible_messages).
BEGIN;
CREATE TABLE IF NOT EXISTS kb.graph_position (
  slot text PRIMARY KEY, lsn pg_lsn NOT NULL, published_lsn pg_lsn NOT NULL DEFAULT '0/0'
);
CREATE TABLE kb.m_channels (
  id text PRIMARY KEY, workspace_id uuid NOT NULL, name text NOT NULL, is_private boolean NOT NULL,
  memory_enabled boolean NOT NULL DEFAULT false, knowledge_enabled boolean NOT NULL DEFAULT false,
  -- Copied from Space. NULL means not copied yet; the reader fills it on start.
  topic text, description text, archived boolean, version bigint NOT NULL
);
CREATE TABLE kb.m_threads (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  channel_id text NOT NULL REFERENCES kb.m_channels(id) ON DELETE CASCADE,
  root_message_id text, last_activity_at timestamptz, reply_count integer NOT NULL DEFAULT 0, version bigint NOT NULL
);
CREATE TABLE kb.m_sessions (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  thread_id text NOT NULL REFERENCES kb.m_threads(id) ON DELETE CASCADE,
  title text NOT NULL, state text NOT NULL, version bigint NOT NULL
);
CREATE TABLE kb.m_people (
  id text PRIMARY KEY, workspace_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('human','agent'))
);
CREATE TABLE kb.m_messages (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  thread_id text NOT NULL REFERENCES kb.m_threads(id) ON DELETE CASCADE,
  author_id text REFERENCES kb.m_people(id) ON DELETE SET NULL,
  sequence bigint NOT NULL, revision bigint NOT NULL, created_at timestamptz NOT NULL,
  memory boolean NOT NULL, knowledge boolean NOT NULL,
  body text NOT NULL, embedding pgcontext.vector(384) NOT NULL, version bigint NOT NULL
);
CREATE TABLE kb.m_session_turns (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  session_id text NOT NULL REFERENCES kb.m_sessions(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES kb.m_messages(id) ON DELETE CASCADE
);
CREATE TABLE kb.m_topics (id text PRIMARY KEY, workspace_id uuid NOT NULL, name text NOT NULL);
CREATE TABLE kb.m_thread_topics (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  thread_id text NOT NULL REFERENCES kb.m_threads(id) ON DELETE CASCADE,
  topic_id text NOT NULL REFERENCES kb.m_topics(id) ON DELETE CASCADE, extract_version bigint NOT NULL
);
CREATE TABLE kb.m_facts (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  thread_id text NOT NULL REFERENCES kb.m_threads(id) ON DELETE CASCADE,
  topic_id text REFERENCES kb.m_topics(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('fact','decision','procedure','answer')),
  text text NOT NULL, extract_version bigint NOT NULL, embedding pgcontext.vector(384) NOT NULL
);
CREATE TABLE kb.m_fact_evidence (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  fact_id text NOT NULL REFERENCES kb.m_facts(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES kb.m_messages(id) ON DELETE CASCADE
);
CREATE TABLE kb.m_knowledge (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  channel_id text NOT NULL REFERENCES kb.m_channels(id) ON DELETE CASCADE,
  kind text NOT NULL, title text NOT NULL, revision integer NOT NULL, version bigint NOT NULL
);
-- Evidence keeps the thread so the link survives when the message is not indexed (its channel may have memory off).
CREATE TABLE kb.m_knowledge_evidence (
  id text PRIMARY KEY, workspace_id uuid NOT NULL,
  knowledge_id text NOT NULL REFERENCES kb.m_knowledge(id) ON DELETE CASCADE,
  thread_id text NOT NULL REFERENCES kb.m_threads(id) ON DELETE CASCADE,
  message_id text NOT NULL
);
CREATE INDEX ON kb.m_threads(channel_id, last_activity_at DESC);
CREATE INDEX ON kb.m_sessions(thread_id);
CREATE INDEX ON kb.m_messages(workspace_id, thread_id, sequence);
CREATE INDEX ON kb.m_messages(author_id);
CREATE INDEX ON kb.m_session_turns(session_id);
CREATE INDEX ON kb.m_session_turns(message_id);
CREATE INDEX ON kb.m_thread_topics(thread_id);
CREATE INDEX ON kb.m_thread_topics(topic_id);
CREATE INDEX ON kb.m_facts(thread_id);
CREATE INDEX ON kb.m_facts(topic_id);
CREATE INDEX ON kb.m_fact_evidence(fact_id);
CREATE INDEX ON kb.m_fact_evidence(message_id);
CREATE INDEX ON kb.m_knowledge(workspace_id, channel_id);
CREATE INDEX ON kb.m_knowledge_evidence(knowledge_id);
CREATE INDEX ON kb.m_knowledge_evidence(thread_id);
CREATE INDEX ON kb.m_knowledge_evidence(message_id);

GRANT SELECT ON kb.m_channels, kb.m_threads, kb.m_sessions, kb.m_people, kb.m_messages, kb.m_session_turns,
  kb.m_topics, kb.m_thread_topics, kb.m_facts, kb.m_fact_evidence, kb.m_knowledge, kb.m_knowledge_evidence
  TO space_knowledge_reader;

CREATE ROLE space_memory_collection NOLOGIN;
GRANT space_memory_collection TO space_knowledge_reader;
GRANT USAGE ON SCHEMA kb, pgcontext TO space_memory_collection;
GRANT SELECT ON kb.m_messages, kb.m_facts TO space_memory_collection;
SET SESSION AUTHORIZATION space_memory_collection;
SELECT pgcontext.create_collection('kb_memory', 'kb.m_messages');
SELECT pgcontext.register_vector('kb_memory', 'embedding', 'embedding', 384, 'cosine');
SELECT pgcontext.register_lexical_source('kb_memory', 'text', ARRAY['body']);
SELECT pgcontext.create_collection('kb_memory_facts', 'kb.m_facts');
SELECT pgcontext.register_vector('kb_memory_facts', 'embedding', 'embedding', 384, 'cosine');
SELECT pgcontext.register_lexical_source('kb_memory_facts', 'text', ARRAY['text']);
RESET SESSION AUTHORIZATION;

SELECT graph.create_graph('space_memory');
SELECT graph.add_table_to_graph('space_memory','kb.m_channels'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_threads'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_sessions'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_people'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_messages'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_session_turns'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_topics'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_thread_topics'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_facts'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_fact_evidence'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_knowledge'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_memory','kb.m_knowledge_evidence'::regclass,'id',ARRAY['id']);
SELECT graph.add_edge_to_graph('space_memory','kb.m_threads'::regclass,'channel_id','kb.m_channels'::regclass,'id', label := 'in_channel', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_messages'::regclass,'thread_id','kb.m_threads'::regclass,'id', label := 'in_thread', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_messages'::regclass,'author_id','kb.m_people'::regclass,'id', label := 'written_by', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_sessions'::regclass,'thread_id','kb.m_threads'::regclass,'id', label := 'of_thread', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_session_turns'::regclass,'session_id','kb.m_sessions'::regclass,'id', label := 'in_session', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_session_turns'::regclass,'message_id','kb.m_messages'::regclass,'id', label := 'turn_message', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_thread_topics'::regclass,'thread_id','kb.m_threads'::regclass,'id', label := 'discusses_thread', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_thread_topics'::regclass,'topic_id','kb.m_topics'::regclass,'id', label := 'discusses_topic', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_facts'::regclass,'topic_id','kb.m_topics'::regclass,'id', label := 'about', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_facts'::regclass,'thread_id','kb.m_threads'::regclass,'id', label := 'from_thread', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_fact_evidence'::regclass,'fact_id','kb.m_facts'::regclass,'id', label := 'evidence_of', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_fact_evidence'::regclass,'message_id','kb.m_messages'::regclass,'id', label := 'supported_by', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_knowledge'::regclass,'channel_id','kb.m_channels'::regclass,'id', label := 'in_channel', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_knowledge_evidence'::regclass,'knowledge_id','kb.m_knowledge'::regclass,'id', label := 'supports', bidirectional := false);
SELECT graph.add_edge_to_graph('space_memory','kb.m_knowledge_evidence'::regclass,'thread_id','kb.m_threads'::regclass,'id', label := 'from_thread', bidirectional := false);
SELECT graph.grant_graph('space_memory','space_knowledge_reader','read');
COMMIT;
SELECT * FROM graph.build_graph('space_memory', true);
