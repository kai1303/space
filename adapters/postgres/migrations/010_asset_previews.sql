ALTER TABLE assets ADD COLUMN preview jsonb;
ALTER TABLE assets ADD CONSTRAINT asset_preview_object CHECK (
  preview IS NULL OR (jsonb_typeof(preview) = 'object' AND preview->>'kind' IN ('image','pdf','audio','video','text','unsupported'))
);
