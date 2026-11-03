ALTER TABLE assets ADD COLUMN processing_token uuid;
ALTER TABLE assets ADD COLUMN processing_until timestamptz;
ALTER TABLE assets ADD CONSTRAINT asset_processing_claim CHECK (
  (processing_token IS NULL) = (processing_until IS NULL)
);
