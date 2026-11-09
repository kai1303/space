#!/bin/sh
set -eu
umask 077

# Keep the generated login across container recreation and provision existing DB volumes too.
if [ ! -e /credentials/password ]; then
  tmp=$(mktemp /credentials/.password.XXXXXX)
  trap 'rm -f "$tmp"' EXIT
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$tmp"
  chgrp 1000 "$tmp"
  chmod 0440 "$tmp"
  ln "$tmp" /credentials/password || test -f /credentials/password
fi
test "$(wc -c < /credentials/password)" -eq 64
psql -X -w -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'space_infra_monitor') THEN
    CREATE ROLE space_infra_monitor LOGIN CONNECTION LIMIT 1;
    COMMENT ON ROLE space_infra_monitor IS 'Space infrastructure metrics collector';
  ELSIF shobj_description('space_infra_monitor'::regrole, 'pg_authid')
        IS DISTINCT FROM 'Space infrastructure metrics collector' THEN
    RAISE EXCEPTION 'space_infra_monitor already exists and was not created by the monitoring stack';
  END IF;
END $$;
ALTER ROLE space_infra_monitor SET default_transaction_read_only = on;
ALTER ROLE space_infra_monitor SET statement_timeout = '1500ms';
GRANT CONNECT ON DATABASE workplace TO space_infra_monitor;
GRANT USAGE ON SCHEMA public TO space_infra_monitor;
GRANT SELECT (created_at) ON public.event_outbox TO space_infra_monitor;
COMMIT;
SQL
# psql hashes the generated password locally before issuing ALTER ROLE.
password=$(cat /credentials/password)
printf '%s\n%s\n' "$password" "$password" | psql -X -w -v ON_ERROR_STOP=1 -c '\password space_infra_monitor'
