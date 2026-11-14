ALTER TABLE channels ADD COLUMN encrypted_since timestamptz CHECK(encrypted_since IS NULL OR kind='direct');
ALTER TABLE messages ADD COLUMN encrypted jsonb;
ALTER TABLE messages ADD CONSTRAINT encrypted_message_shape CHECK(encrypted IS NULL OR
  (author_type='human' AND text='Encrypted message' AND document IS NULL AND attachments='[]'::jsonb AND agent_response IS NULL AND workflow_name IS NULL));

CREATE TABLE dm_device_accounts (
 channel_id uuid NOT NULL, user_id uuid NOT NULL, recovery_hash text NOT NULL,
 PRIMARY KEY(channel_id,user_id), FOREIGN KEY(channel_id,user_id) REFERENCES channel_members(channel_id,user_id) ON DELETE CASCADE
);
CREATE TABLE dm_devices (
 id uuid PRIMARY KEY,channel_id uuid NOT NULL,user_id uuid NOT NULL,public_key text NOT NULL CHECK(length(public_key) BETWEEN 100 AND 8192),
 device_proof text NOT NULL CHECK(device_proof ~ '^[a-f0-9]{64}$'),
 revoked boolean NOT NULL DEFAULT false, FOREIGN KEY(channel_id,user_id) REFERENCES dm_device_accounts(channel_id,user_id) ON DELETE CASCADE,
 UNIQUE(channel_id,public_key)
);

ALTER FUNCTION chat_message_payload(messages) RENAME TO chat_message_payload_without_envelope;
CREATE FUNCTION chat_message_payload(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT chat_message_payload_without_envelope(m) || CASE WHEN m.encrypted IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('encrypted',m.encrypted) END
$$;
ALTER FUNCTION retained_message_payload(jsonb) RENAME TO retained_message_without_envelope;
CREATE FUNCTION retained_message_payload(payload jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT retained_message_without_envelope(payload)-'encrypted'
$$;
ALTER FUNCTION deleted_message_payload(jsonb,timestamptz) RENAME TO deleted_message_without_envelope;
CREATE FUNCTION deleted_message_payload(payload jsonb,deleted_at timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT deleted_message_without_envelope(payload,deleted_at)-'encrypted'
$$;
CREATE FUNCTION enforce_dm_encryption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
   IF NEW.deleted_at IS NOT NULL OR NEW.retained_at IS NOT NULL THEN NEW.encrypted=NULL; END IF;
 ELSIF (NEW.encrypted IS NOT NULL) IS DISTINCT FROM (SELECT encrypted_since IS NOT NULL FROM channels WHERE id=NEW.channel_id) THEN
   RAISE EXCEPTION 'direct message encryption mode mismatch';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER encrypted_dm_write BEFORE INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION enforce_dm_encryption();
