ALTER TABLE assets DROP CONSTRAINT asset_preview_object;
ALTER TABLE assets ADD CONSTRAINT asset_preview_object CHECK (
  preview IS NULL OR (jsonb_typeof(preview) = 'object' AND preview->>'kind' IN ('image','pdf','audio','video','text','office','unsupported'))
);
-- Use the normal byte classifier on the next authorized preview of an existing Office upload.
UPDATE assets SET preview = NULL WHERE preview->>'kind' = 'unsupported'
  AND name ~* '\.(docx|xlsx|pptx|odt|ods|odp)$';
