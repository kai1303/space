# Workspaces and users

The hierarchy is **Workspace → Channels**. Each workspace has its own name,
membership list and roles. Any authenticated user can create a workspace and becomes
its owner. User profiles and credentials are global; membership in one workspace
never grants access to another.

Browser/API sessions use Better Auth email/password accounts. See
[authentication setup](authentication.md). Legacy operator tokens require explicit
development-only opt-in and are disabled by default.

## Backend modules

| Component | Responsibility |
| --- | --- |
| UserStore | Global identity/profile; read/update own display name |
| WorkspaceStore | Workspaces, membership, roles and member offboarding |
| Shared access checks | Active workspace membership, plus explicit channel membership |
| Provisioning | Operator-created development users and explicit legacy owner initialization |

Drizzle maps `workspaces` and `workspace_members`. Profiles and credentials remain
intact when a member leaves a workspace, along with memberships in other workspaces.

## API

All routes require a valid Better Auth session cookie. Cookie-authenticated writes
also require a configured trusted Origin. Legacy `Authorization: Bearer <development token>`
is accepted only with explicit development opt-in. POST/PATCH require JSON. Unknown
body/query fields fail validation. Names are trimmed, nonempty and limited to 100
characters.

| Method | Route | Body / response |
| --- | --- | --- |
| GET / PATCH | `/v1/me` | Own profile / `{ "display_name": "Kai" }` |
| POST | `/v1/workspaces` | `{ "name": "Engineering" }`; 201, workspace + actor role |
| GET | `/v1/workspaces` | Page of joined workspaces, each including actor role |
| GET / PATCH | `/v1/workspaces/:workspaceId` | Workspace + actor role / `{ "name": "Platform" }` |
| GET / POST | `/v1/workspaces/:workspaceId/members` | Active member directory / `{ "user_id": "<UUID>", "role": "member" }` |
| PATCH / DELETE | `/v1/workspaces/:workspaceId/members/:userId` | `{ "role": "admin" }` / remove or leave |

POST membership returns 201; DELETE returns 204. Adding the same active member with
the same role is idempotent; a changed role returns `409 member_already_exists` and
must use PATCH. Members must be existing users.

List routes accept `?limit=50&after=<UUID>` (maximum 100). Responses are
`{ "items": [...], "next_cursor": "<UUID or null>" }`, ordered by resource/member ID.
Member directories return IDs, display names, roles and joined_at, never credentials.
There is no global user search or implicit discovery of unjoined workspaces.

## Roles and access

Workspace roles are owner, admin and member. Owners manage all roles; admins manage
ordinary members and settings; members read their workspace and may leave. Only an
owner appoints/demotes owners or admins. The last active owner cannot leave or be
demoted (`409 last_owner`).

Outsiders and inactive members receive 404; members lacking management authority
receive 403. Task reads/proposals, grants and dispatch use the same workspace access
checks. Workspace roles do not override explicit channel membership or grant
control over another user's agents.

## Removal and concurrency

Member removal deactivates the workspace membership, removes channel memberships and
disables owned installations in that workspace. Historical foreign keys, tasks and
messages remain intact. Transfer/add workspace ownership before removing its last
active owner.

Rejoining a workspace restores neither channel access nor installation enablement.
Recorded agent grants remain unusable until current membership and enablement
requirements are met. Removal blocks new authorization and queued dispatch; it does
not cancel an external action already running. An already-authorized in-flight
request may finish.

Membership mutations and installation creation coordinate through workspace locks,
so removal cannot miss a concurrently created agent. Workspace changes append to
`workspace_events`, which is append-only under normal SQL access. Database admins
are trusted; there is no public audit-reader endpoint in this slice.

## Migration

Back up the database, then run `pnpm migrate` with DATABASE_URL set before starting
the updated backend. Migration 014 removes the obsolete organization tables,
organization audit table and workspace parent column. Workspace IDs, roles, audit
events and content remain intact. Memberships denied by an inactive former parent
membership become inactive workspace memberships, preserving the existing access
boundary. Previous migration files remain unchanged.

The former organization endpoints and owner-provisioning command are removed.
POST `/v1/workspaces` accepts only `{ "name": "Engineering" }`. Internal callers use
`WorkspaceStore.create(actor, { name })` and `UserStore` for profiles. Bootstrap
output includes WORKSPACE_ID with no parent identifier.

## Development users and legacy owners

```sh
pnpm migrate
USER_DISPLAY_NAME='Kai' USER_ENV_FILE=.env.kai pnpm user:create
```

Provisioning writes USER_ID and USER_TOKEN to an exclusive mode-0600 file; it never
prints the token or overwrites an existing file. File-write failure rolls back user
creation. The database stores only the token hash. This is development provisioning;
normal signup/login uses Better Auth.

After sourcing that file locally, create a workspace:

```sh
curl -X POST http://127.0.0.1:3000/v1/workspaces \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Acme"}'
```

For a legacy workspace with no owner, a trusted operator selects an active member:

```sh
WORKSPACE_ID='<workspace UUID>' OWNER_USER_ID='<member UUID>' pnpm workspace:owner
```

Initialization is once-only and identical repeats are no-ops. It cannot replace an
existing owner. New workspaces and demo seeds already have owners.

## Checks and remaining scope

`TEST_DATABASE_URL=... pnpm test:workspace` exercises permissions, concurrent
last-owner changes, installation/removal races, offboarding/rejoin, legacy upgrades
and provisioning in disposable PostgreSQL schemas. The complete backend suite also
exercises task/worker regressions.

Email invitations, workspace discovery and join policies, shared channels and real
agent task dispatch remain separate modules. The main chat UI uses authenticated
workspace data; the design-system gallery retains local examples. Development
credentials lack expiry/rotation/session controls and do not constitute production
login.
