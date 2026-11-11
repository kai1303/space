-- Run once in a dedicated provider database. Source tables belong to the installer.
BEGIN;
CREATE EXTENSION IF NOT EXISTS graph;
CREATE EXTENSION IF NOT EXISTS pgcontext;
CREATE ROLE space_knowledge_reader LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE space_knowledge_collection NOLOGIN;
GRANT space_knowledge_collection TO space_knowledge_reader;
CREATE SCHEMA kb;
CREATE TABLE kb.access (
  workspace_id uuid NOT NULL, requester_id uuid NOT NULL, channel_id uuid NOT NULL,
  include_private boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, requester_id, channel_id)
);
CREATE TABLE kb.entities (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE kb.ownership (
  id text PRIMARY KEY, service text NOT NULL REFERENCES kb.entities,
  person text NOT NULL REFERENCES kb.entities, url text NOT NULL, private boolean NOT NULL DEFAULT true
);
CREATE TABLE kb.passages (
  id text PRIMARY KEY, service text NOT NULL REFERENCES kb.entities, title text NOT NULL,
  body text NOT NULL, url text NOT NULL, embedding pgcontext.vector(384) NOT NULL,
  private boolean NOT NULL DEFAULT true
);
GRANT USAGE ON SCHEMA kb, graph, pgcontext TO space_knowledge_reader, space_knowledge_collection;
GRANT SELECT ON kb.passages TO space_knowledge_collection;
GRANT SELECT ON kb.access, kb.entities, kb.ownership TO space_knowledge_reader;
ALTER TABLE kb.passages ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb.ownership ENABLE ROW LEVEL SECURITY;
CREATE POLICY visible_passage ON kb.passages FOR SELECT TO space_knowledge_reader
  USING (NOT private OR current_setting('kb.private', true) = 'on');
CREATE POLICY visible_owner ON kb.ownership FOR SELECT TO space_knowledge_reader
  USING (NOT private OR current_setting('kb.private', true) = 'on');
SET SESSION AUTHORIZATION space_knowledge_collection;
SELECT pgcontext.create_collection('kb_passages','kb.passages');
SELECT pgcontext.register_vector('kb_passages','embedding','embedding',384,'cosine');
SELECT pgcontext.register_lexical_source('kb_passages','text',ARRAY['title','body']);
RESET SESSION AUTHORIZATION;
SELECT graph.add_table('kb.entities'::regclass,'id',ARRAY['name']);
SELECT graph.add_edge('kb.ownership'::regclass,'service','kb.entities'::regclass,'person',
                      label := 'owned_by', bidirectional := false);
COMMIT;
