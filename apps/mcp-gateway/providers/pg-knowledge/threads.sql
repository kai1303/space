-- Apply once after schema.sql. Graph metadata contains only source identifiers.
BEGIN;
CREATE TABLE kb.threads (id text PRIMARY KEY);
CREATE TABLE kb.thread_messages (
 id text PRIMARY KEY, workspace_id uuid NOT NULL, channel_id uuid NOT NULL,
 thread_id text NOT NULL REFERENCES kb.threads, revision bigint NOT NULL,
 published boolean NOT NULL DEFAULT false, body text NOT NULL, embedding pgcontext.vector(384) NOT NULL
);
CREATE INDEX ON kb.thread_messages(workspace_id,channel_id,id);
CREATE INDEX ON kb.thread_messages(thread_id,id);
CREATE ROLE space_thread_collection NOLOGIN;
GRANT space_thread_collection TO space_knowledge_reader;
GRANT USAGE ON SCHEMA kb,pgcontext TO space_thread_collection;
GRANT SELECT ON kb.thread_messages,kb.threads TO space_thread_collection;
SET SESSION AUTHORIZATION space_thread_collection;
SELECT pgcontext.create_collection('kb_threads','kb.thread_messages');
SELECT pgcontext.register_vector('kb_threads','embedding','embedding',384,'cosine');
SELECT pgcontext.register_lexical_source('kb_threads','text',ARRAY['body']);
RESET SESSION AUTHORIZATION;
SELECT graph.create_graph('space_threads');
SELECT graph.add_table_to_graph('space_threads','kb.thread_messages'::regclass,'id',ARRAY['id']);
SELECT graph.add_table_to_graph('space_threads','kb.threads'::regclass,'id',ARRAY['id']);
SELECT graph.add_edge_to_graph('space_threads','kb.thread_messages'::regclass,'thread_id','kb.threads'::regclass,'id',
 label := 'in_thread',bidirectional := false);
SELECT graph.grant_graph('space_threads','space_knowledge_reader','read');
COMMIT;
SELECT * FROM graph.build_graph('space_threads',true);
