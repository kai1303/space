-- One bounded, transactionally replaced working copy. The sealed upload stays in object storage.
CREATE TABLE office_edits (
  asset_id uuid PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  channel_editing boolean NOT NULL DEFAULT false,
  edit_epoch integer NOT NULL DEFAULT 0 CHECK (edit_epoch >= 0),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  content bytea,
  CHECK ((revision = 0 AND content IS NULL) OR
         (revision > 0 AND content IS NOT NULL AND octet_length(content) BETWEEN 1 AND 26214400))
);
