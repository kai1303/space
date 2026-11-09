CREATE TABLE auth_session_refresh (
  session_id uuid PRIMARY KEY REFERENCES auth_sessions(id) ON DELETE CASCADE,
  token_hash bytea UNIQUE NOT NULL,
  previous_hash bytea UNIQUE,
  rotated_at timestamptz,
  persistent boolean NOT NULL
);
