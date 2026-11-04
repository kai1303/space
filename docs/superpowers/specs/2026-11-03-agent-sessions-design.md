# Agent sessions

Approved in the chat: one Space thread has many agent sessions. An agent session is one object containing conversation, progress, previews, files and changes; there is no separate workspace object.

Start a named session from a thread, selecting an enabled Local Codex. Each session has its own composer. Normal thread messages do not become session turns. Closing the view retains the session; Stop interrupts its current turn; End makes it read-only. Multiple sessions in a thread keep separate history and outputs.

Layout correction approved November4: use an independent Agent session panel, matching the existing thread panel pattern. Creation and selection live in the source thread's Agent sessions section. Selecting a session or opening a saved agent response opens only that session's conversation and outputs; its panel has no New agent session button or session switcher. Do not add an Agent sessions tab to the thread. Back to thread preserves session drafts and restores the source discussion. Close dismisses the panel without ending any session.

Extend existing agent_sessions, keep task records for approved individual turns, and display tasks as session conversation turns. Reuse channel access, installation grants, ownership approvals, outbox leases and realtime resource updates. Return bounded history, preserve retry identity, reject overlapping turns and fail closed after access revocation. Session turns do not publish duplicate replies into the human thread.

Persist connector-owned Codex state per platform installation and ChatGPT identity in the private connector directory. Persist the mapping from Space session ID to Codex thread ID atomically. First turns create non-ephemeral Codex threads; later turns resume. Missing state for a previously-started session is an explicit error. Persistence does not enable repository, shell or browser tools.

Reuse safe output renderers inside the session view, with honest empty states when no outputs exist. An optional validated output envelope allows trusted adapters to attach previews/files/changes to responses. Test isolation, authorization, approval, duplicate sends, concurrent turns, stop/end, connector restart/resume and UI navigation before applying the local migration and browser verification.

Later November4 correction: remove the thread session manager, agent follow-up banner, Ask an agent and Open agent session actions beneath saved replies. Do not relocate those controls into another part of the thread.
