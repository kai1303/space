ALTER TABLE sidebar_sections
  ADD COLUMN emoji text CHECK (length(emoji) BETWEEN 1 AND 64),
  ADD COLUMN creation_emoji text CHECK (length(creation_emoji) BETWEEN 1 AND 64);
