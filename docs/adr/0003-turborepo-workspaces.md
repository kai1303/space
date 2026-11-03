# ADR 0003: pnpm workspaces and Turborepo

Date: 2026-11-03
Status: Implemented at the owner's request. Supersedes ADR 0001's single root TS build.

Keep the existing directories and introduce eight private workspace packages:
`@space/server`, `@space/worker`, `@space/contracts`, `@space/core`, `@space/postgres`,
`@space/mock`, `@space/tools`, and `@space/tests`. Each owns its manifest, direct
runtime/development dependencies and TypeScript configuration. Internal dependencies
use `workspace:*`; cross-package imports use exported package names.

Libraries compile JS and declarations into local `dist/` directories. No source
condition exports or TypeScript path aliases are required at runtime. App and tools
builds use those same compiled library exports. Root `tsconfig.base.json` holds common
strict options, while each package bounds compilation to its own sources.

Turbo 2.11.10 orchestrates dependency-first builds and typechecks. It caches `dist/**`;
root TS configuration participates in task hashes. Database tests, migration,
bootstrap and demo tasks always execute. Runtime environment variables are explicitly
passed through, so database configuration works under Turbo's strict environment mode.
Local caching is enabled; remote caching is not configured.

`pnpm dev` uses `turbo watch dev`. Apps start after their builds; persistent tasks are
interruptible so dependency changes can trigger rebuild/restart. Operational tools
execute from the repository root to preserve `.env.demo` and relative file behavior.

Docker builds the workspace, then `pnpm deploy --prod` creates standalone server,
worker and tools directories with compiled workspace dependencies and SQL migrations.
The runtime image contains no compiler or Turbo installation. Compose points at the
new app/tools output paths. CI executes the same Turbo build/typecheck/test graph.

Validation: frozen install; 7 package builds; all 8 typechecks; 23 tests; full build
cache restoration after deleting outputs; migration and foundation demo; Docker build,
container migration/demo/API health; and local watch-mode startup. Read-only review
reported no significant conversion issues.

References consulted:
- https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository
- https://turborepo.dev/docs/reference/configuration
- https://turborepo.dev/docs/crafting-your-repository/using-environment-variables
