ALTER TABLE channel_members
  ADD COLUMN notification_mode text CHECK (notification_mode IN ('all','mentions','none')),
  ADD COLUMN muted_until timestamptz,
  ADD COLUMN notify_thread_replies boolean;
