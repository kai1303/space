# Agent activity and project tools

User-approved scope: show event-driven Working, Thinking, Responding, and Using tools activity above the existing session composer. Reuse the existing tool timeline, inputs, and results. Enable project file tools for the explicitly selected `/Users/kai/works/side-project/space` folder.

Implementation uses the maintained MCP filesystem server for project reads, listing, searching, and edits. Native shell, external integrations, approval escalation, and unrestricted filesystem tools stay disabled. Project selection is local (`--project`), never supplied by a platform task. Persistent provider sessions are isolated by project as well as account and installation.

- [x] Add failing tests for activity validation, runtime reasoning/response/tool transitions, terminal cleanup, and composer placement.
- [x] Add a typed optional activity field to accumulated responses; preserve legacy response envelopes.
- [x] Configure the project MCP server in both runtimes and map only its tool events into the existing timeline. Bound snapshots and ignore reasoning contents and replay.
- [x] Add local `--project` selection and project-scoped session identity. Default launches retain chat-only permissions.
- [x] Render agent activity above the shared composer, clear it on terminal states, and reuse the existing tool timeline without a second activity row in the message.
- [x] Run connector, contract, UI, and web tests/builds; exercise actual filesystem-server operations and folder escape rejection. Verify the UI in the browser and report live-provider test limits.
