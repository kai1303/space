# Slack Code channels and Space sessions

Inspected November 14, 2026. The source artifact was Slack’s shipped web client, captured November 3, 2026, from the workspace browser. The file was `client-boot.61a6c08ab09904bb.min.js`, SHA-256 `f35f3ea0f97a9d1473245fa97e03aae38e9599c250995d378347c07215cbd4a3`. REA 6.8.0 analyzed two sets of complete module factories extracted by AST boundaries. The UI and API behavior described in Slack’s public guides supplements that static evidence.

| Evidence | What it establishes |
| --- | --- |
| `ev_6b6e03f0a725227c94e0a8396957b840c8777c52bf2e9e3c26157f1579175afb` | The three client modules ryF3, mhYx, and gSlm include feature gates for parent-channel presentation, code comments and session browsing. Tab selection and mapping distinguish code and pull-request views, saved views, and canvas references. |
| `ev_2a582b131f14488b026cc31ba539aa99e9d672041f2359909de0db84a828054b` | Four client modules map review submission, PR comments, CI outcomes and merge conflicts to system-message presentation. The static evidence establishes render paths, not the upstream events produced by a particular installation. |

Slack documents starting from a mention, origin-message updates, private and public task channels, line comments and batch submission, status filters, per-agent actions and a searchable archive. Slack’s developer documentation also describes the app’s authority to create and update views in the session it serves. We did not operate a live supported Slack agent or observe a private workspace review. Visuals in Space are authored for Space. Sources: [Slack Code guide](https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code), [Agent sessions](https://slack.com/help/articles/33076000248851-Work-with-AI-agents-in-Slack), [Slack Code lifecycle](https://docs.slack.dev/ai/slack-code/lifecycle/).

The machine-readable REA reports and extraction scripts are retained locally under `~/.codex-artifacts/space-slack-code-2026-11-14/`. The announcements describe the broader agent experience and the engineering workflow. [Agentforce in Slack](https://slack.com/blog/news/turn-agents-into-teammates-with-slack) · [Slack Code channels](https://slack.com/blog/news/slack-code-channels-for-agents)

## Space behavior

- Source messages show the latest task status, a bounded result excerpt, and a shortcut to the available diff, preview or files. Results in a thread attach to the recorded originating message when available. Earlier records fall back to the thread root.
- A line review captures the file path, old or new line where available, patch line, a digest of the exact patch, and a quoted excerpt. Submitting from Changes sends one follow-up through the agent’s regular authorization flow. Submitting on a shared snapshot posts to the human review discussion.
- The Team tab lets participants discuss work. Session managers can invite individual full workspace members or explicitly share the review room with the workspace. These reviewers receive the human discussion and selected artifact snapshots. Access to the original thread, provider context, and execution permissions is still checked independently.
- A participant with source access can ask a second installed agent to help. Space creates a linked session, passes the explicitly selected context, and applies the helper installation’s approval rules.
- Browse sessions searches authorized work and filters it by status, creator, agent and channel. Personal sidebar archiving and ending a session for everyone are separate operations.
- Installed AG-UI providers can open the current task as a managed session, publish supported outputs and HTTPS actions, and end the session. A PR action opens its configured destination on the Git host, where the user’s own repository permissions apply. See the [AG-UI protocol](../architecture/ag-ui.md).
