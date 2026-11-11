-- One pending (conflicted) turn-end update per installation and scope. The latest one replaces an earlier one.
CREATE TABLE memory_pending (
  installation_id uuid NOT NULL REFERENCES agent_installations(id) ON DELETE CASCADE,
  scope_key text NOT NULL CHECK (scope_key ~ '^(thread|session):[0-9a-f-]{36}$'),
  base_revision integer NOT NULL CHECK (base_revision >= 0),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 280),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 6000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, scope_key)
);
