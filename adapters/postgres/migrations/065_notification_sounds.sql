ALTER TABLE mention_preferences ADD COLUMN sound_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE notifications ADD COLUMN sound_claimed_at timestamptz;
