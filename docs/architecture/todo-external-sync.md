# External source → Space Todos

Space accepts normalized task snapshots through a source-scoped HTTP API. This is one-way sync: Space never writes task changes back to an external system. A source-specific connector or webhook handler must translate the external system's events into the request below. No periodic polling or provider-specific connector is included.

## Functions

| Method and path | Purpose | Authentication |
| --- | --- | --- |
| `POST /v1/workspaces/:workspaceId/hub/todo-sources/:sourceId` | Create a source; body `{ "name": "Issue tracker" }` | User session |
| `GET /v1/workspaces/:workspaceId/hub/todo-sources` | List your sources, with cursor pagination | User session |
| `POST /v1/workspaces/:workspaceId/hub/todo-sources/:sourceId/token` | Rotate the token; body `{}` | User session |
| `POST /v1/workspaces/:workspaceId/hub/todo-sources/:sourceId/revoke` | Revoke the token; body `{}` | User session |
| `POST /v1/todo-sync/:sourceId/items` | Create or update one external task | Source bearer token |
| `GET /v1/todo-sync/:sourceId/items?limit=25&after=…` | List import receipts to reconcile external IDs with Space IDs | Source bearer token |

The caller generates `sourceId` as a UUID once and retains it. Creation returns `201` with the source metadata and a `token`. A conflicting source ID returns `409`; it does not overwrite the source. If the creation response is lost, the owner can rotate the token using that same source ID.

Source management uses Space's existing session authentication and trusted `Origin` check for cookie-authenticated writes. Sources belong to the signed-in user and workspace; a source cannot choose a different task owner or workspace. Development tokens are not production integration credentials.

Tokens expire after 90 days, are returned only on creation/rotation, and are stored only as SHA-256 digests. Store the returned token in the connector's secret store. Rotation invalidates the previous token immediately and retains the source identity and imported tasks. Rotation also re-enables a revoked source. Revocation or loss of active workspace membership prevents further imports. Revoking a source retains its existing tasks.

## Import a task

```sh
# SPACE_ORIGIN, SOURCE_ID, and TODO_SYNC_TOKEN are provided by your environment.
curl --fail-with-body "$SPACE_ORIGIN/v1/todo-sync/$SOURCE_ID/items" \
  -H "Authorization: Bearer $TODO_SYNC_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "external_id": "ISSUE-123",
    "revision": "1",
    "title": "Review the release checklist",
    "completed": false,
    "url": "https://issues.example.com/ISSUE-123"
  }'
```

Example response:

```json
{
  "id": "a62627ef-89d7-4f8f-8c06-fac15e8d11f2",
  "external_id": "ISSUE-123",
  "revision": "1",
  "result": "applied"
}
```

- `external_id`: stable, nonempty source identifier, up to 200 characters. Unique within a source.
- `revision`: positive monotonically increasing decimal integer **string**, up to PostgreSQL's signed 64-bit maximum. Use a durable source version or connector-assigned sequence. Arrival order is not a source version; do not assign a new revision to a retry.
- `title`: required task text, up to 500 characters.
- `completed`: required boolean.
- `document`: optional Space rich-text document, for example `{ "ops": [{ "insert": "Review the release checklist\n" }] }`.
- `url`: optional HTTP(S) link without embedded credentials. Space displays this link but does not fetch it.

Each request is a full snapshot of source-owned fields. Omitting `document` or `url` clears those fields. Requests must be JSON and fit the server's 32 KiB request limit. Unknown fields are rejected; a source cannot write personal reminders, Saved/Clear state, message references, or arbitrary user/workspace IDs.

## Delivery and conflict rules

| Delivery | Result |
| --- | --- |
| New external ID | Create one Todo |
| Higher revision | Update text, rich document, completion, and source link |
| Same revision and same normalized payload | `unchanged`; no write, including after a local edit |
| Lower revision | `stale`; no write; response includes the current revision |
| Same revision with different payload | `409 source_revision_conflict` |

The database enforces one Todo per source/external ID and uses an atomic conditional upsert. Overlapping deliveries retain the highest revision. A successful response acknowledges a committed write. After a transport failure or `5xx`, retry the identical payload with bounded backoff. Invalid inputs (`400`), credentials (`401`), and conflicting revision reuse (`409`) require correction rather than blind retries.

Task text and completion may be edited locally, but the next higher source revision replaces them. Reminders, Saved, and Clear remain local. In particular, later imports do not resurrect a locally cleared Todo or move it out of Saved. Replaying an already applied revision does not overwrite local edits. Source-side deletion is not inferred from an absent item; this API does not yet accept deletion events. Send completion updates when that represents the source's actual state.

Imports use the existing durable resource event and reminder triggers, so changes reach the Todo UI without polling. Source tokens can read only receipts (`id`, `external_id`, `revision`), including receipts for cleared tasks. They cannot retrieve personal task contents, local state, messages, or other sources. Receipt lists are paginated using `next_cursor`; they are for initial/recovery reconciliation, not recurring scans.

## Implementation and verification

- Migration: `048_todo_sync.sql`.
- Contracts: `packages/contracts/todo-sync.ts`.
- Store: `adapters/postgres/todo-sync.ts`.
- Routes: `apps/server/todo-sync.ts`.
- Integration coverage: `tests/integration/todo-sync.test.ts` (idempotency, ordering, overlapping writers, scope, credential lifecycle, validation and receipt pagination).
- UI coverage: `apps/web/src/WorkspaceTodos.test.tsx` (source label/link plus existing Todo behavior).

This exposes a generic integration interface. No external provider has been connected or granted credentials by this change. A provider adapter must map IDs, payloads, and monotonic revisions and deliver its events to this endpoint.

Local verification on 2026-11-04: 26 Todo/sync/reminder integration tests and 12 Todo UI tests passed; contracts, Postgres adapter, server, and web builds passed, as did the tests package typecheck. Migration048 was applied to the local database. No production deployment or provider connection was performed.
