# Fastify backend migration

Requested: adopt a backend framework. Choose Fastify for the current TypeScript API.
Scope: HTTP routing, bounded JSON parsing, request authentication hooks, errors and
application lifecycle. Contracts, deterministic policy, PostgreSQL and worker remain
separate modules. Keep existing routes and response/error shapes.

Plan:
1. Adapt HTTP integration checks to the Fastify app lifecycle and add regression cases
   for payload limits, media types, cross-workspace access, all read routes and errors.
2. Add Fastify only to @space/server; replace manual URL routing and body buffering.
3. Authenticate in onRequest before parsing; retain strict contract parsers rather
   than silently stripping unknown fields through validator defaults.
4. Close the pool on application shutdown; test inject and real network behavior.
5. Run Turbo build/typecheck/tests plus container API smoke; record the framework ADR.

Status: implemented with Fastify 5.12.8. All 26 tests, Turbo build/typecheck, frozen
install and Docker build passed. Container API health returned 200; SIGTERM shutdown
exited 0. Read-only review found no significant migration issues.
