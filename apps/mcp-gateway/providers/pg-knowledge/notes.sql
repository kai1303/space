-- Apply once after schema.sql (and threads.sql when thread search is used).
BEGIN;
CREATE TABLE kb.notes (
 id text PRIMARY KEY, workspace_id uuid NOT NULL, channel_id uuid NOT NULL,
 revision integer NOT NULL, body text NOT NULL, embedding pgcontext.vector(384) NOT NULL
);
CREATE INDEX ON kb.notes(workspace_id, channel_id, id);
CREATE ROLE space_note_collection NOLOGIN;
GRANT space_note_collection TO space_knowledge_reader;
GRANT USAGE ON SCHEMA kb, pgcontext TO space_note_collection;
GRANT SELECT ON kb.notes TO space_note_collection;
SET SESSION AUTHORIZATION space_note_collection;
SELECT pgcontext.create_collection('kb_notes', 'kb.notes');
SELECT pgcontext.register_vector('kb_notes', 'embedding', 'embedding', 384, 'cosine');
SELECT pgcontext.register_lexical_source('kb_notes', 'text', ARRAY['body']);
RESET SESSION AUTHORIZATION;
COMMIT;
