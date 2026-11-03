# Organization hierarchy

> Historical plan, superseded on 2026-11-03 by the workspace-only model.
> See [Workspaces and users](../architecture/workspace-users.md) for current APIs and permissions.

Selected and approved 2026-11-03: follow Slack's organization/workspace distinction.
Supersedes the organization=workspace assumption in 0006. Status: implemented and locally verified.

## Design

- Organizations contain multiple workspaces. An authenticated creator becomes org
  owner and owner of its initial General workspace in one transaction.
- Organization and workspace roles/memberships are separate owner/admin/member
  records. Organization membership grants no implicit workspace or channel access.
- Org owners/admins create workspaces. Workspace owners/admins manage workspace
  membership; targets must already be active organization members. Org roles alone
  do not override workspace roles, private-channel membership or agent ownership.
- Org members list only their joined workspaces through the existing workspace
  list API. There is no broad workspace discovery or join-policy feature yet.
- Organization removal deactivates all child workspace memberships, deletes their
  channel memberships and disables owned installations atomically. Rejoining the
  organization does not restore workspace memberships. Removing a last workspace
  owner fails with last_workspace_owner until ownership has been transferred.
- Last-owner protection applies separately at organization and workspace levels.
- Global profiles and development bearer tokens remain independent of membership.

## Migration and boundaries

Migration 004 creates one parent organization per existing workspace with a new ID,
copies its member roles/status, and adds organization_id to workspaces/memberships.
Existing workspace/user/channel/task IDs remain unchanged. Composite foreign keys
bind workspace memberships to both the correct workspace and organization member.
Existing organization_events are renamed workspace_events without modifying their
rows; a new organization_events table records organization-scoped changes.
Existing ownerless workspaces remain ownerless; trusted operator commands initialize
organization and workspace owners explicitly, never inferred from agent ownership.

All child membership mutations/creation lock the parent org FOR SHARE before the
workspace lock. Org mutations/offboarding lock the org FOR UPDATE first, then child
workspaces in ID order. Installation creation follows org → workspace lock order.
Shared access checks require active org AND workspace membership, including task
reads, proposals and dispatch. In-flight already-authorized actions may finish.

## API

GET/POST /v1/organizations; GET/PATCH /v1/organizations/:organizationId;
GET/POST /v1/organizations/:organizationId/members;
PATCH/DELETE /v1/organizations/:organizationId/members/:userId;
POST /v1/organizations/:organizationId/workspaces.
Existing /v1/workspaces reads/settings/member routes remain. POST /v1/workspaces
now requires {organization_id,name}; it never implicitly creates an organization.
List endpoints use existing bounded UUID cursor pagination. Org creation returns
the organization plus initial_workspace; other org reads return org metadata/role.

## Execution checklist

- [x] Add failing API and database tests for hierarchy, separate roles, cross-org
  membership, removal/rejoin, ownership protection, concurrency and legacy migration.
- [x] Add migration/mappings and update bootstrap; split WorkspaceStore from true
  OrganizationStore; reuse small paging/role helpers, not a generic CRUD framework.
- [x] Add org routes; adapt existing workspace routes and permission checks;
  update installation creation locks and trusted initialization commands.
- [x] Run focused and complete backend tests, build/typecheck and an independent
  review. Document migration, API, policies, exclusions and verification results.

Login, invitations, UI, public/hidden/request-to-join workspace policies, shared
channels, billing and agent integration are outside this approved hierarchy change.


## Verification — 2026-11-03

- 47 backend contract/integration tests passed; 19 cover profiles, organization /
  workspace hierarchy, roles, migrations and provisioning.
- Scoped backend build and strict typechecks passed across server, worker, tools,
  adapters, contracts/core and tests.
- Migration from v3 preserved original task rows and workspace audit rows exactly,
  retained workspace IDs/roles/inactive memberships, and produced distinct parent
  IDs. Replaying migration added no duplicate parents.
- Deterministic database-lock tests verified new installations cannot escape either
  workspace or organization removal. Parallel owner changes retain an active owner.
- Live HTTP smoke against the compiled Fastify app created an organization and two
  workspaces, and verified the separate compiled organization/workspace owner CLIs.
  Smoke schemas and credential files were removed afterward.
- Independent read-only review found no actionable issues in role boundaries,
  tenant access, offboarding, migration or lock ordering.
- No existing development database was migrated, production deployment performed,
  frontend connected or new Docker image built. Run `pnpm migrate` against the
  intended development database before using the updated server.
