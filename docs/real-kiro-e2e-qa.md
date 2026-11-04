# Real Kiro end-to-end QA

Tested locally on 2026-11-04 with Kiro CLI 2.32.0, ACP v3, a real authenticated Kiro account, and the Space browser UI. This is local functional evidence, not production or load-test coverage.

## Environment

- Dedicated PostgreSQL schema `kiro_e2e_20261104`, migrated through 039; existing public schema untouched.
- Real Better Auth test user, workspace `Kiro E2E QA`, channel `kiro-testing`.
- Real PostgreSQL CDC, NATS, worker, Redis, API on 3193, and web preview on 5193.
- Used a production web build to avoid other development chats' HMR rebuilds. Moved the browser to `kiro-e2e.localhost` to isolate cookies from other localhost apps.
- User completed sign-in into Space's isolated Kiro home. Existing CLI/IDE credentials were not copied.

## Observed results

| Scenario | Result |
| --- | --- |
| Browser login, workspace and channel creation | Passed |
| Members → Kiro → pairing code → real connector | Passed after launcher fix below |
| Channel agent enablement | Authenticated API setup; browser-only onboarding gap remains below |
| Browser agent mention routes to a retained Kiro session | Passed; owner mention was automatically authorized by Navigator |
| Real inference and UI delivery | `SPACE_KIRO_E2E_OK`, persisted as a completed task |
| Connector process restart and retained context | Asked for the earlier codeword without including it in the new prompt; Kiro returned `AMBER-742` |
| Streaming | Story paragraphs appeared while the turn was still running |
| Stop during active streaming | UI showed Stopped; backend recorded `session_stopped`; partial response retained |
| Follow-up after Stop, without another connector restart | `SPACE_KIRO_AFTER_STOP_OK`, persisted as completed |
| Reload persistence | Earlier turns remained visible after API/worker restarts and browser re-login |

Session: `3af791ec-b9f4-41a5-a5c0-70cacd92e0de` in the dedicated QA schema. The first failed turn remains in its history as evidence of the bug found during testing. The other failed task is the intentionally stopped story; the three verification responses completed.

## Bugs found and fixed

1. The split Kiro launcher searched the isolated `HOME/.local/bin` for `kiro-cli-chat`. Resolve the installed launcher through PATH and symlinks, and use its executable sibling when present. Keep the isolated HOME unchanged. Regression coverage checks both split and single executable layouts.
2. Kiro emits `fetch_cloud_config` housekeeping as ACP `tool_call` / `tool_call_update` notifications. The adapter treated this as a forbidden model tool and terminated the turn. It now recognizes only this exact `kind: other` metadata and its bounded set of matching update IDs. Permission requests and other tool events remain rejected. A regression test reproduces the observed wire shape.

## Remaining limitation

The current thread UI does not expose the documented **Ask an agent** control. Members still tells users to enable agents there. For this test, channel enablement used the authenticated API, then all message, resume, and Stop interactions used the browser. Therefore the complete browser-only path from pairing to first usable mention is **not** a pass. This is shared thread UI work, separate from the Kiro transport fixes. Explicit approval by a different agent owner was not exercised; these were owner-requested turns.

Codex real inference, multiple simultaneous accounts, network-fault recovery, and production deployment were not exercised in this run.

## Verification artifacts

- `pnpm --filter @space/connector test`: **69 passed**, including both new regression tests and existing rejection/cancellation tests.
- `pnpm --filter @space/connector typecheck`: passed.
- Root build passed before live QA; connector rebuild passed with the fixes.
- `git diff --check`: passed.
- Local logs: `/tmp/space-kiro-e2e-tests.log`, `/tmp/space-kiro-e2e-typecheck.log`, `/tmp/space-kiro-e2e-results.json`.
- Screenshots: `/Users/kai/.codex/visualizations/2026/11/04/01a1a4cb-9597-7250-a206-dd02990a1156/space-kiro-e2e-resume.jpg` and `space-kiro-e2e-stop.jpg`.

The Kiro ACP setup follows the [official migration guide](https://kiro.dev/docs/cli/v3/acp-migration/). Recognition of the configuration-refresh event is based on the installed runtime's observed traffic, not an assumed generic tool exception.

## Local review state

The isolated QA app is left running at `http://kiro-e2e.localhost:5193` with its browser conversation open. The Kiro connector remains paired to this QA environment, not the existing main workspace. Test credentials and harness scripts are under `/tmp` and are not committed. The existing main API and public database were not migrated or restarted by this test.
