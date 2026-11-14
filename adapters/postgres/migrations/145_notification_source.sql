-- The recipient uniqueness indexes are partial and cannot cover erasure across all kinds.
CREATE INDEX notifications_message_source ON notifications(message_id);
