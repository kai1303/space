ALTER TABLE users
  ADD COLUMN full_name text NOT NULL DEFAULT '',
  ADD COLUMN title text NOT NULL DEFAULT '',
  ADD COLUMN name_pronunciation text NOT NULL DEFAULT '',
  ADD COLUMN phone text NOT NULL DEFAULT '',
  ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN presence text NOT NULL DEFAULT 'active' CHECK (presence IN ('active', 'away')),
  ADD COLUMN status jsonb;
