# Organization and user foundation

> Historical plan, superseded on 2026-11-03 by the workspace-only model.
> See [Workspaces and users](../architecture/workspace-users.md) for current APIs and permissions.

Selected 2026-11-03, ahead of agent integration. Status: implemented and locally verified.

The original organization=workspace assumption below is superseded by
[0007 — Organization hierarchy](0007-organization-hierarchy.md).

## Scope and design

An organization is the existing workspace tenant, not a second hierarchy. Retain
workspace IDs and `/v1/workspaces` routes. This first backend increment covers:

- U01 profiles: authenticated `GET /v1/me`, `PATCH /v1/me` with display_name.
- U02 organizations: create, list, read, rename. Creation assigns owner atomically.
- U03 members: list active members, add an existing user, change role, remove/leave.
- U04 offboarding: inactive memberships preserve historical FKs; clear channel
  memberships and disable owned installations in the same transaction. Rejoining
  does not restore channels or enable agents. Existing history remains intact.

Roles are owner, admin, member. Members read organization and member directory.
Admins rename and manage ordinary members only. Owners manage every role. Members
may leave; admins may leave; an owner cannot leave/demote the last active owner.
Organization row locks serialize membership/settings changes, including concurrent
last-owner changes. Outsiders receive 404; members lacking a role receive 403.
Authenticated users may create organizations. No public global user directory.

Strict request contracts reject unknown fields, including user/owner IDs in profile
or organization settings. Cursor pagination returns at most 100 rows per request.
Membership/settings changes append an immutable audit event in their transaction.
Profile names and organization names are trimmed, nonempty, at most 100 characters.

Migration is additive. Existing users/organizations get neutral display names;
existing memberships remain active ordinary members. Never infer administrator
authority from an agent's ownership. A trusted operator can explicitly initialize
the first owner of a legacy workspace. New bootstrap fixtures set owner explicitly.
No membership API deletes users or changes a person's global credentials.

Authentication remains the existing bearer-token development mechanism. Login,
registration, invitations/email, organization UI, channel management and agent
integration are separate modules. This does not complete all of W13/W14.

## Implementation checklist

- [x] Write API integration tests against real isolated PostgreSQL schemas: profiles,
  organization creation/isolation, role authorization, paging, concurrent last-owner
  protection, offboarding with task/agent history, audit rollback and replay migration.
  Run `pnpm --filter @space/tests exec tsx --test integration/organization.test.ts`
  with TEST_DATABASE_URL; expect missing-route failures before implementation.
- [x] Add `packages/contracts/organization.ts` parsers and exports; SQL migration
  `003_organization_users.sql`; update Drizzle mappings, migration list, bootstrap.
- [x] Add `adapters/postgres/organization.ts` for profile/org/membership transactions
  and `apps/server/organization.ts` for routes; register via existing auth hooks.
- [x] Update shared access checks to require active membership. Add trusted operator
  provisioning/legacy-owner initialization in a separate module and CLI, keeping
  bearer tokens in an exclusive mode-0600 file rather than logs.
- [x] Run backend tests, typecheck and build; document routes, operator commands,
  migration behavior and limits. Update backlog with U01–U04 and remaining modules.

## Acceptance boundary

Tests prove local API/data behavior, not production authentication or live-agent
cancellation. Removal prevents subsequent authorized reads and new dispatches;
an already-authorized in-flight request/action may finish. Raw database access is
trusted operator access. No changes to the frontend gallery are part of this work.


## Verification — 2026-11-03

- All 38 backend contract/integration tests passed against PostgreSQL in disposable
  schemas, including 10 organization-focused tests.
- Backend builds and strict TypeScript checks passed for server, worker, tools,
  adapter, contracts/core/mock, and tests.
- Legacy schema upgrade and repeated migration preserved users/memberships without
  inferring privileged roles. Operator owner initialization passed.
- Operator CLI smoke verified mode-0600 credentials, refusal to overwrite an existing
  file, no duplicate user after that failure, and owner assignment. Temporary
  credentials and schemas were removed.
- Independent read-only review identified an installation/offboarding race. A
  deterministic database-lock test reproduced it, then passed after creation took
  the organization's shared lock. Reviewer confirmed the fix and lock ordering.
- No production deployment, real-login verification, frontend integration or new
  Docker image was part of these checks. Existing development database contents
  were not migrated; use `pnpm migrate` before running the updated server.
