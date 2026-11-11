-- Apply once after threads.sql. Each passage participates in the existing in_thread graph.
BEGIN;
ALTER TABLE kb.thread_messages
 ADD COLUMN source_message_id uuid,
 ADD COLUMN asset_id uuid,
 ADD COLUMN part integer,
 ADD CONSTRAINT markdown_passage_source CHECK (
   (asset_id IS NULL AND part IS NULL AND source_message_id IS NULL) OR
   (asset_id IS NOT NULL AND part IS NOT NULL AND part>=0 AND source_message_id IS NOT NULL)
 );
CREATE INDEX ON kb.thread_messages(workspace_id,channel_id,source_message_id) WHERE asset_id IS NOT NULL;
SET SESSION AUTHORIZATION space_thread_collection;
SELECT pgcontext.create_collection('kb_markdown','kb.thread_messages');
SELECT pgcontext.register_vector('kb_markdown','embedding','embedding',384,'cosine');
SELECT pgcontext.register_lexical_source('kb_markdown','text',ARRAY['body']);
RESET SESSION AUTHORIZATION;
COMMIT;
