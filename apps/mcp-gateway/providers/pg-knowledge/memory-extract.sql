-- Apply once after memory-graph.sql. The extraction step guards each thread with this version:
-- a run writes only if its version is newer, through one conditional UPDATE.
ALTER TABLE kb.m_threads ADD COLUMN IF NOT EXISTS extract_version bigint NOT NULL DEFAULT 0;
