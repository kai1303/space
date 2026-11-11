-- Messages is always first and is not part of the movable list.
ALTER TABLE channels ADD COLUMN tab_order text[] NOT NULL
  DEFAULT ARRAY['files','pins','memory','navigator']::text[]
  CHECK (array_ndims(tab_order) = 1 AND cardinality(tab_order) = 4
    AND tab_order @> ARRAY['files','pins','memory','navigator']::text[]);
-- The existing channels_resource_delivery trigger publishes committed order changes.
