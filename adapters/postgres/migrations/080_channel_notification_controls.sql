ALTER TABLE channel_members
  ADD COLUMN channel_desktop_enabled boolean,
  ADD COLUMN badge_every_post boolean NOT NULL DEFAULT false,
  ADD COLUMN follow_every_thread boolean NOT NULL DEFAULT false;
