ALTER TABLE assets ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE assets ADD CONSTRAINT encrypted_asset_metadata CHECK (
 NOT encrypted OR (name='Encrypted file' AND type='application/octet-stream' AND task_id IS NULL AND queue_input_id IS NULL)
);
