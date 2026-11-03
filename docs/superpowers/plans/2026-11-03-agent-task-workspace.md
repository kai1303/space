# Agent task workspace implementation plan

**Goal:** Build the approved conversation task card and result workspace UI. The user selected UI first; real sandbox execution is explicitly deferred.

**Architecture:** Reuse task reads, paginated task events, owner approval, shared UI primitives, and Space tokens. Open a task-scoped panel from a conversation card. Keep outputs as typed view props until an execution adapter supplies them. A labeled gallery example demonstrates preview, file downloads, changes, logs, and stopped compute without representing a real execution.

- [x] Add interaction tests for task states, result tabs, preview isolation, file selection/download, event pagination, and revoked access.
- [x] Add a task card, pure result workspace, and task-scoped API loader. Keep existing approval authorization and unsupported controls intact.
- [x] Connect conversation and thread cards to one workspace panel; close conflicting panels and restore focus. Saved structured responses retain an entry point.
- [x] Add a labeled interactive example to the existing design system, using local sample outputs and a sandboxed preview.
- [x] Run web tests and production build; inspect 1280px and 390px layouts. Preview filtering, source selection, diff/log tabs, and offline preview behavior were exercised in the browser.

No database schema, worker runtime, provider credentials, deployment, or paid execution changes are needed for this slice.

## Verification

The final full web suite passed with 154 tests. The production build passed, including TypeScript checks. An independent static review identified missing Escape/focus behavior during initial loading; that was fixed with a regression test. This checkout has concurrent unrelated changes, so these checks describe the combined local web app.
