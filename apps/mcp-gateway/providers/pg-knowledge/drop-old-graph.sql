-- Run once per knowledge database after the Graph RAG reader has built space_memory.
-- Removes the old knowledge graph and the old message rows of the thread index. Markdown file passages stay.
-- Everything dropped here is derived from Space and is rebuilt by the reader, so nothing is lost.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kb.graph_position WHERE published_lsn > '0/0') THEN
    RAISE EXCEPTION 'space_memory has not been published yet; start graph-reader.mjs first';
  END IF;
END $$;
BEGIN;
-- pgGraph needs the edges, then the tables, removed from a graph before it can be dropped.
DO $$
BEGIN
  IF to_regclass('kb.g_channels') IS NOT NULL THEN
    PERFORM graph.remove_edge_from_graph('space_knowledge', label) FROM unnest(ARRAY['in_channel','of_thread','supports','from_thread']) AS label;
    PERFORM graph.remove_table_from_graph('space_knowledge', t::regclass)
      FROM unnest(ARRAY['kb.g_evidence','kb.g_knowledge','kb.g_sessions','kb.g_threads','kb.g_channels']) AS t;
    PERFORM graph.drop_graph('space_knowledge');
  END IF;
END $$;
DROP TABLE IF EXISTS kb.g_evidence, kb.g_knowledge, kb.g_sessions, kb.g_threads, kb.g_channels;
-- Thread messages moved to kb.m_messages. File passages (asset_id set) keep using kb.thread_messages.
SELECT pgcontext.delete_points('kb_threads', ARRAY(SELECT id FROM kb.thread_messages WHERE asset_id IS NULL));
DELETE FROM kb.thread_messages WHERE asset_id IS NULL;
DELETE FROM kb.threads t WHERE NOT EXISTS (SELECT 1 FROM kb.thread_messages m WHERE m.thread_id = t.id);
COMMIT;
SELECT * FROM graph.build_graph('space_threads', true);
