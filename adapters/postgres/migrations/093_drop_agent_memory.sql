-- Memory is built from messages in the Graph RAG store, so the agent-written memory is gone.
-- This deletes every saved thread and session memory. Take a backup first: nothing can rebuild them from messages.
DROP FUNCTION IF EXISTS memory_visible_summaries(uuid,uuid,uuid,uuid[]);
DROP TRIGGER IF EXISTS memory_revisions_update ON memory_revisions;
DROP FUNCTION IF EXISTS enqueue_memory_update();
DROP TABLE IF EXISTS memory_pending;
DROP TABLE IF EXISTS memory_revisions;
