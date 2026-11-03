# Storage concurrency implementation plan

Goal: release PostgreSQL connections and locks before asset or memory provider I/O.

- Add regressions using a one-connection pool and paused storage callbacks. A second
  query must finish while storage is paused; concurrent Markdown edits must not lose data.
- Replace asset processing/cleanup row locks with token-fenced, expiring atomic
  claims. Waiters poll without retaining a connection. Release claims after errors;
  renew live claims and recover expired ones. Keep short database-only upload admission.
- Seal original objects with conditional create so reclaimed/retried processors
  cannot replace final bytes; bound concurrent buffered asset jobs in the application.
- Authorize memory operations using ordinary reads, release connections before calling
  providers, and revalidate access/settings before returning. Keep token creation's
  bounded quota check inside its existing short database-only transaction.
- Serialize Markdown mutations in the provider using a shared-filesystem lock with
  heartbeat/stale recovery. Check revisions inside that boundary. Custom providers
  must supply atomic writes themselves.
- Test concurrent processing, cleanup retries, stale claims, authorization changes,
  filesystem concurrency, MCP and migration upgrades; run workspace typechecking.

Database UPDATEs still acquire their normal brief internal locks. This change removes
explicit row locks/open transactions across storage work, not PostgreSQL's internal
concurrency control. Disabling/revoking blocks subsequent operations; an authorized
provider write already in flight may complete, and its response is reauthorized.
