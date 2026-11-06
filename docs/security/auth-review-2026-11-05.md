# Authentication and authorization review — 2026-11-05

This review covered the API/session boundary and workspace, channel, guest, agent, memory, notification, asset, search, and Todo access checks. Findings were reproduced against local PostgreSQL and exercised through the API. This is a scoped code review and local regression check, not a production penetration test.

## Fixed findings

| Finding | Before | Change and regression coverage |
| --- | --- | --- |
| Unverified email used to grant membership | A person could register another person's email, then receive workspace access if an administrator added that email. | Email-based member creation requires `email_verified`. Explicit account-ID provisioning remains available to authorized administrators. A real cookie-session test proves denial before verification and success afterward. |
| Guest participant directory disclosure | Guests could enumerate unrelated workspace members and connected agents through the participants endpoint. | Filter people and agent owners with the existing guest peer-visibility predicate before pagination. Tests cover both guest types, one-item pages, existing DMs, and shared-channel access. |
| Creator privileges survived conversion to guest | A channel creator converted to a guest retained memory and Navigator management rights. | Management requires active full membership as well as creator/admin/owner authority. Tests reject memory configuration, memory-key creation, and Navigator configuration by former creators who are now guests. |
| Legacy mention previews bypassed guest assignments | Stored mention notifications could disclose text from unassigned public channels, including after a member became a guest or lost channel access. | Notification creation, activity rows, unread counts, and read mutations enforce current guest channel assignments. Tests cover historical notifications, new mentions, both guest types, and assignment removal. |

The membership error shown in the UI now directs administrators to email invitations when an account has not verified its address. The change does not globally prohibit unverified users from signing in or creating their own workspaces.

## Validation

- Regression tests reproduced all four findings before the fixes.
- Authentication, workspace membership, and participant/management regressions: 25 passed.
- Legacy mentions, guest mentions, and notification regressions after the final change: 24 passed.
- Repository build and type checks passed; the final server/dependency/test build and type checks also passed after the mentions change.
- Broad contract/integration run: 482 tests, 477 passed, five readiness assertions failed because the custom CDC slot was not recognized. All three affected realtime test files then passed on standard disposable infrastructure: 31 passed, zero failed. The two new legacy-mention regressions ran separately in the 24-test group above.

The first broad run encountered exhausted storage reservations on the existing shared NATS broker. Validation moved to a disposable broker. Readiness tests required a separate disposable PostgreSQL instance: the first isolated database used a custom replication-slot name to avoid the shared development slot, while readiness intentionally recognizes the standard slot names. These setup failures were investigated separately from application regressions; shared broker streams and replication slots were not deleted.

## Remaining dependency findings and limits

`pnpm audit --prod --json` reported nine advisories: two critical, one high, five moderate, and one low. They were not resolved by these access-control changes:

| Packages | Advisory IDs | Follow-up |
| --- | --- | --- |
| `tinypool` | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | Upgrade the resolved test-worker dependency; advisories describe gadgets requiring a separate prototype-pollution primitive. |
| `vitest`, `@vitest/mocker` | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | Upgrade the test tooling and validate compatibility. Better Auth declares Vitest as an optional peer; presence in the production audit is not by itself proof of a reachable production endpoint. |
| `zod` | GHSA-mrhx-c7xc-m3w5 | Review the `@ag-ui/client` dependency chain and upgrade its older Zod version without forcing an incompatible major version. |
| `glob`, `minimatch` | GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249 | Upgrade and validate filesystem-connector pattern handling. |
| `quill` | GHSA-v3m3-f69x-jf25 | Audit HTML-export sinks; the audit offered no patched version. |

The source search did not find application calls to the identified HTML-export or mocker-plugin entry points. That is not a complete reachability proof. Dependency remediation remains separate work; this review does not claim that the repository is free of security issues.

Production cookie/proxy configuration, email delivery, deployed dependencies, and infrastructure were not verified. No deployment was performed.
