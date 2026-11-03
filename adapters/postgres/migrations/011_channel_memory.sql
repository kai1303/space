ALTER TABLE channels ADD COLUMN memory_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN memory_provider text NOT NULL DEFAULT 'markdown'
  CHECK (memory_provider ~ '^[a-z][a-z0-9-]{0,63}$');
