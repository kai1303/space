# Agent task workspace

Task activity in a channel or thread has an **Open workspace** action. Saved structured agent responses retain the same action after streaming ends. Opening a workspace closes the other conversation panels; closing it restores focus to the entry point when it is still mounted.

The panel uses the existing authenticated task read endpoint. Active tasks refresh every three seconds and on window focus. Session expiry or a denied task read clears the task view, and a task switch ignores late responses from the previous task.

## Result views

- **Preview:** an isolated iframe, responsive viewport controls, reload, and an external-link action for HTTPS previews. A stopped preview does not hide saved outputs.
- **Files:** filename filtering, source inspection with the shared code block, and text-file downloads.
- **Changes:** expandable supplied patches with additions and deletions.

The workspace opens directly into Preview, with Files and Changes alongside it. Task status, approvals, activity, and agent responses stay in the conversation. The panel has no duplicate task summary or Logs tab.

`AgentWorkspaceView` accepts typed `TaskOutputs` as view data. `AgentTaskWorkspace` currently reads task status and access: no execution adapter supplies preview/file/change outputs yet. The empty states say so. Resume, cancel, remote desktop takeover, publishing, and applying code changes are not wired and are not presented as working controls.

## Interactive example

Open `/design-system#agent-workspace` to try a clearly labeled local example. It includes a small interactive app preview, downloadable example files, a patch, task-state controls, and a stopped-preview state. No task is submitted and no sandbox is created.

Implementation: `apps/web/src/AgentTaskWorkspace.tsx`, `AgentWorkspaceExample.tsx`, and `agent-task-workspace.css`. Interaction and integration checks are in `AgentTaskWorkspace.test.tsx` and `Chat.test.tsx`.
