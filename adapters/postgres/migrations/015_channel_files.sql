CREATE INDEX assets_channel_message_ready ON assets(channel_id, message_id, id)
  WHERE status = 'ready' AND message_id IS NOT NULL;
