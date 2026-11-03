# Turborepo conversion

Requested scope: convert the current root TypeScript project to a pnpm/Turbo monorepo.

Keep existing folders and behavior. Add eight private workspace packages with explicit
`workspace:*` dependencies, ESM exports of compiled JS/declarations, and per-package
TypeScript configuration. Replace cross-package relative imports with package imports.
Keep intra-package relative imports. Tests form one test workspace; operational scripts
form one tools workspace. No new product modules or frameworks.

Turbo owns dependency-first build/typecheck/test tasks. Build outputs are cached;
PostgreSQL tests and all side-effecting operational tasks are uncached. Declare runtime
environment passthrough explicitly. Preserve root commands and root-relative demo files.

Docker builds with Turbo, then uses pnpm deploy for production-only server, worker and
tools distributions, retaining SQL migrations. CI uses the same task graph.

Verification: frozen install, Turbo graph/dry-run, clean build, typecheck, all existing
23 tests, compiled foundation demo, cache reuse, and Docker build/runtime smoke checks.

Status: implemented. Frozen install, build/typecheck, all 23 tests, cache restoration,
compiled demo, Docker build/runtime checks and local watch startup verified.
