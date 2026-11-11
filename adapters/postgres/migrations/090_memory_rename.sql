-- A saved thread or session memory used to be called a checkpoint. Rename the table and the objects that carry its name.
ALTER TABLE thread_checkpoints RENAME TO memory_revisions;
ALTER INDEX thread_checkpoints_thread_revision RENAME TO memory_revisions_thread_revision;
ALTER INDEX thread_checkpoints_session_revision RENAME TO memory_revisions_session_revision;
ALTER INDEX thread_checkpoints_snapshot RENAME TO memory_revisions_snapshot;
ALTER INDEX thread_checkpoints_session_snapshot RENAME TO memory_revisions_session_snapshot;
ALTER INDEX thread_checkpoints_channel_recent RENAME TO memory_revisions_channel_recent;
ALTER TABLE memory_revisions RENAME CONSTRAINT thread_checkpoints_summary TO memory_revisions_summary;
ALTER TRIGGER thread_checkpoints_memory_update ON memory_revisions RENAME TO memory_revisions_update;
