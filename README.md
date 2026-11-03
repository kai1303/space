# Agent-native workplace

## Frontend

The first frontend slice is a Slack-grounded design system, with reusable React
components in `packages/ui` and an interactive gallery in `apps/web`. The main
chat UI now uses these components with Better Auth, saved channel history,
Socket.IO messages/replies, agent task approval, and channel creation.

- `/` or `/chat`: the main authenticated chat UI (requires the API, PostgreSQL and Redis).
- `/design-system`: the standalone component gallery (no backend required).
- `/workspace`: the earlier synthetic workspace preview.

See [main chat UI verification](docs/main-chat-ui-qa.md) for the tested scope and current limits.

```sh
pnpm install --frozen-lockfile
pnpm web                  # http://127.0.0.1:5173; gallery at /design-system
pnpm test:ui              # component interaction tests
```

Explore light/dark tokens, typography, controls, dialogs, and a working local
conversation/thread preview. See [the component guide](docs/design-system.md) for
usage, source observations, accessibility behavior, and verification limits.
Additional workplace screens remain in the backlog.

Frontend tooling requires Node.js 22.12+ or a newer supported Node release.

The full-size [workplace preview](http://127.0.0.1:5173/workspace) adds a rich-text
composer, scoped local search, a resizable conversation sidebar and a searchable
color-token inspector. The gallery links to it. See the
[Slack research report](docs/research/slack-workplace.md) for actual REA CLI evidence,
source observations and reconstruction boundaries, and
[workplace QA](docs/slack-workplace-qa.md) for verification.

The [standard channel/DM composer](http://127.0.0.1:5173/#chat-composer) is also
available in the gallery. Its [REA research](docs/research/slack-composer.md)
records the actual editor/toolbar/key-policy evidence and remaining fidelity gaps.

A workplace for humans and independently operated agents. The current completed
backend implementation scope is **Foundation (W01–W04)** plus **workspace/users
(U01–U04)** and the first **realtime chat** slice: profiles, workspaces, roles and membership/offboarding. Foundation
includes contracts, access checks, catalog records and owner-managed grants. Task-flow code is an experimental compatibility
consumer. Local Codex pairing and connection status are implemented; real task dispatch,
cloud adapters, Navigator and remaining workplace screens are later modules. No model API key is required.

Better Auth email/password login is available at `/chat`; see the
[authentication guide](docs/architecture/authentication.md) for required secret/origin
configuration. Workspace and user APIs are ready for backend development. Each workspace has its own members, roles and channels. See the [API and operator guide](docs/architecture/workspace-users.md)
for permissions, development-user provisioning and legacy owner assignment.

## Connected chat

`/chat` now connects to Fastify through Socket.IO over WebSocket. Redis distributes
update notifications; PostgreSQL stores durable history. Channels, threaded replies,
reconnect catch-up and mock-agent task approval/progress/results are implemented.
See the [chat run guide and contract](docs/architecture/realtime-chat.md).
Better Auth now provides email/password accounts and cookie sessions. The mock
connector remains in place. See the [authentication setup guide](docs/architecture/authentication.md).

## Connect local Codex

Open **Members → Connect Local Codex** in `/chat`. From this checkout, run the
command shown in the dialog, paste its pairing code, and complete **Continue with
ChatGPT** locally. No repository or channel selection is required.

```sh
pnpm connector --url http://127.0.0.1:5174 --connect
```

Use your actual web origin. The agent appears beside human members with connection
and sign-in status. Its owner can disconnect it from the directory. This slice
implements enrollment and readiness; it does not execute tasks or read conversations.
See the [connection architecture](docs/architecture/local-codex-connection.md) and
[connector guide](apps/connector/README.md) for setup and the local OSS account boundary.

## Channel memory

Each channel can opt in to shared memory from **Memory** beside Messages. The default
provider stores canonical `.md` files; channel members can edit notes, import text
documents, save selected messages with source links, search and export. Managers
control opt-in and can choose other server-installed memory providers. Memory is off
by default. See the [channel memory guide](docs/architecture/channel-memory.md) for
storage, permissions, provider adapters and API contracts.

Agents and Navigator can connect through the [memory MCP](docs/architecture/memory-mcp.md)
to read channel context, search, save extracted knowledge with sources, and update
memory. Channel managers create revocable read/write-scoped keys from the Memory panel.

## Chat files

Chat uploads use a private **SeaweedFS 4.52** bucket through its S3-compatible API.
Files upload directly from the browser using a short-lived signed form. The API
checks the stored byte count and copies the upload into a server-only object key
before it can appear in a message. Downloads require current chat access and use
an expiring attachment URL. The limit is **25 MiB per file**.

See the [asset storage guide](docs/architecture/assets.md) for configuration,
permissions, local startup and backup boundaries. The complete Compose stack
includes SeaweedFS; a host-run API needs all six `ASSET_STORAGE_*` values from
`.env.example`. With all six unset, chat works with uploads disabled.

## Local setup

Requires Node.js 22+, pnpm 8.10.3, PostgreSQL 16+ and Redis 7+ (or Docker Compose).
SeaweedFS provides optional chat file storage.

```sh
pnpm install --frozen-lockfile
docker compose up -d postgres redis seaweedfs
export DATABASE_URL=postgres://workplace:local_demo_only@127.0.0.1:55438/workplace
export TEST_DATABASE_URL="$DATABASE_URL"
export REDIS_URL=redis://127.0.0.1:56380
export TEST_REDIS_URL="$REDIS_URL"
pnpm migrate
pnpm foundation:demo
```

The demo creates a fresh seeded workspace and two installations. It verifies owner
isolation, grants, revocation and disablement without invoking any agent or printing
credentials. Each run keeps its demonstration records in the development database.
The Compose password is a local development default; use dedicated deployment secrets
before exposing a service beyond localhost.

```sh
pnpm test:foundation   # contracts + real PostgreSQL foundation tests
pnpm test:workspace    # profiles, roles, membership and upgrade tests
pnpm test:auth         # Better Auth accounts, cookie/session security and sockets
pnpm test              # also runs experimental task-flow regressions
pnpm typecheck
pnpm build
```

Integration tests create and remove a random schema in `TEST_DATABASE_URL`. Point this
at a development/test database whose role can create schemas. Missing database config
fails the test command rather than silently skipping integration tests. `pnpm test:contracts` needs no database. Turbo builds each package into its own `dist/` directory, including PostgreSQL migrations.

## Backend

The HTTP backend uses **Fastify 5 + TypeScript** in `@space/server`.

- Explicit routes and shared authentication hooks in `apps/server/api.ts`.
- Framework JSON parsing, a 32 KiB default body limit (128 KiB for rich chat messages) and consistent error responses.
- Strict domain validation in `@space/contracts`; authorization in core/persistence.
- Drizzle ORM for typed queries/transactions over a shared `pg` pool; a separate task worker.
- Fastify application shutdown closes the production database pool.
- HTTP integration tests use both a real listener and Fastify `inject()`.

Run `pnpm server` for the API, or `pnpm dev` for API and worker together, with
`DATABASE_URL` set. See [ADR 0004](docs/adr/0004-fastify-backend.md).

## Database

Database code lives in `@space/postgres`:

- `database.ts`: centralized connection-pool setup and Drizzle initialization.
- `schema.ts`: typed mappings for the existing PostgreSQL tables.
- Repositories use Drizzle query builders and transactions.
- PostgreSQL advisory locks and atomic outbox claims use parameterized Drizzle SQL.
- `pnpm migrate` applies the existing reviewed SQL migrations through Drizzle and keeps
  the existing `schema_migrations` history. It does not reset existing data.

SQL migrations remain the source of truth for constraints, indexes and audit triggers.
The table mappings are query schemas; Drizzle Kit generation/push is not configured.
See [ADR 0005](docs/adr/0005-drizzle-postgres.md) for this adoption boundary.

## Monorepo tooling

pnpm workspaces + Turborepo 2.11.10 manage twelve private packages. Each has its own
manifest, direct dependencies, exported compiled modules and TypeScript configuration.
Cross-package imports use `@space/*`; workspace dependencies use `workspace:*`.

| Package            | Directory            |
| ------------------ | -------------------- |
| `@space/contracts` | `packages/contracts` |
| `@space/core`      | `packages/core`      |
| `@space/postgres`  | `adapters/postgres`  |
| `@space/redis`     | `adapters/redis`     |
| `@space/mock`      | `adapters/mock`      |
| `@space/server`    | `apps/server`        |
| `@space/worker`    | `apps/worker`        |
| `@space/tools`     | `scripts`            |
| `@space/tests`     | `tests`              |
| `@space/ui`        | `packages/ui`        |
| `@space/web`       | `apps/web`           |
| `@space/connector` | `apps/connector`     |

```sh
pnpm build                 # dependency-first builds with local caching
pnpm typecheck             # checks every workspace
pnpm test                  # database tests always execute
pnpm dev                   # watch, build and run API + worker (DATABASE_URL and REDIS_URL required)
pnpm server                # build and start API only
pnpm worker                # build and start worker only
pnpm exec turbo run build --filter=@space/server...
```

`turbo.json` defines the task graph. Builds cache each package's `dist/**`; integration
tests and operational commands are uncached. Database and runtime environment variables
are explicitly forwarded. No remote cache is configured. Root commands for migrations,
bootstrap and demos continue to work; demo files remain relative to the repository root.
Use `pnpm --filter @space/<name> add <dependency>` to add dependencies to their owner.

Docker uses `pnpm deploy --prod` to package the API, worker and tools independently.
`docker compose up --build` runs PostgreSQL, Redis, SeaweedFS, migrations, server and worker. It does not
create users automatically. See [ADR 0003](docs/adr/0003-turborepo-workspaces.md).

## Code boundaries

| Path                                                       | Responsibility                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/contracts/`                                      | Runtime-neutral types, version 1.0 invocation/events, strict input parsers |
| `packages/core/policy.ts`                                  | Deterministic eligibility and approval policy                              |
| `adapters/postgres/access.ts`                              | Shared workspace/channel/thread access checks                              |
| `adapters/postgres/foundation.ts`                          | Durable definitions, installations, scoped grants and audit                |
| `adapters/postgres/migrations/`                            | Transactional, versioned migrations                                        |
| `tests/contracts/`, `tests/integration/foundation.test.ts` | Foundation acceptance checks                                               |

The foundation exposes **internal TypeScript APIs**, not network enrollment endpoints.
The application supplies an authenticated actor ID; these methods never trust actor
identity from a request body. Definitions are trusted operator-published immutable
catalog entries. Owners create separate installations and explicitly grant access.

See [foundation API and contract guide](docs/architecture/foundation.md),
[small-module backlog](docs/plans/module-backlog.md), and
[architecture decisions](docs/adr/0001-core-boundaries.md).

## Scope and distribution

Local connector pairing, hashed installation credentials and authenticated status transport
are implemented. Real agent task dispatch remains pending. Email/password authentication is implemented; email verification,
password-reset delivery, human social login and MFA remain outside this slice. Disabling/revoking blocks new dispatch;
it does not promise to cancel an already-running external action. The project intends
to be open source, but a license has not yet been selected.
