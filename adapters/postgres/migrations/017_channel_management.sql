ALTER TABLE channels
  ADD COLUMN topic text NOT NULL DEFAULT '' CHECK (length(topic) <= 250),
  ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  ADD COLUMN archived_at timestamptz;
