# SeaweedFS Assets Implementation Plan

> **For agentic workers:** Use the subagent-driven-development skill for independent storage and frontend units; the primary agent implements coupled contracts, persistence and routes. Do not commit the user's untracked repository.

**Goal:** Support private, durable chat attachments using self-hosted SeaweedFS.

**Architecture:** Signed browser POSTs write temporary objects. The API verifies and copies them to immutable final keys; PostgreSQL owns lifecycle and authorization. Chat messages carry asset IDs and durable attachment metadata.

**Tech Stack:** Existing Fastify, PostgreSQL/Drizzle, React/Quill, AWS S3 protocol SDK against SeaweedFS.

- [x] Storage: add `apps/server/storage.ts`, S3 protocol dependencies, pinned SeaweedFS Compose service, `.env.example`, Turbo env passthrough and setup documentation. Interface: `createUpload(key,size): Promise<{url,fields}>`, `finalize(stagingKey,finalKey,size): Promise<void>`, `download(key,name): Promise<string>`, `remove(key): Promise<void>`. Five-minute POST policies enforce exact key/size and octet-stream MIME; finalization checks source/copy size and ETag. Configure CORS and bucket on explicit initialization. Verify with real SeaweedFS.
- [x] Contracts and persistence: add `AssetAttachment={id,name,size,type}`, `AssetUpload={asset,upload:{url,fields},expires_at}`; add bounded `asset_ids` to messages, preserving absent-field shape. Add migration `009_assets.sql`, Drizzle mappings, AssetStore lifecycle/access/cleanup, message asset validation/atomic association and event metadata. Write failing contract and PostgreSQL integration checks before implementation. Reuse existing channel/workspace locks.
- [x] HTTP and lifecycle: register GET `/v1/assets/config`, POST `/v1/channels/:channelId/assets`, POST `/v1/assets/:assetId/complete`, GET `/v1/assets/:assetId/download`. Storage absence returns disabled config and 503 for upload operations. Setup storage from env in main and schedule bounded expired-asset cleanup with shutdown handling. Extend socket command validation for `asset_ids`.
- [x] Frontend: implement signed multipart POST upload with progress/error/retry and preserved drafts, enable uploads when config permits, forward asset IDs through messageSender with safe retry identity, render downloadable attachments in channels and threads. Add meaningful UI/client tests and run them before/after implementation.
- [x] Verify: run contract tests, database/Redis regressions, real SeaweedFS upload/download and policy failures, UI tests, full typecheck/build. Independently review spec and code quality, correct findings, document exact verification limits.


## Verified result

- Full `turbo run test --concurrency=2` passed: 84 backend/contract, 56 UI,
  32 web, 5 storage unit and 20 connector tests.
- `pnpm typecheck` and `pnpm build` passed. Vite reports existing dependency
  module-directive warnings; build completes.
- `pnpm test:assets` passed all seven database and real API/Seaweed checks.
- `pnpm --filter @space/server test:storage` passed real signed-policy/privacy/
  immutability checks against SeaweedFS 4.52.
- Browser QA passed real file selection/upload, attachment-only send, reload,
  and identical-byte download. Isolated QA schema and objects were removed.
- Independent spec and quality review approved after deadline/cleanup and
  late-acknowledgment fixes. No production deployment or remote TLS/restore check.

SeaweedFS remains running locally with its persistent Compose volume. Existing
untracked repository work and concurrent agent/member features were preserved;
no commits were created.
