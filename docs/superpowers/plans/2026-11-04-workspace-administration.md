# Workspace administration implementation record

Goal: compare Slack's workspace administration in Brave and apply its relevant UI and behavior to Space's existing workspace module.

Architecture: retain Space's workspace routes, role policy, transactional audit and event subscription. Introduce a bounded directory read and expose the existing member mutations in a dedicated administrative dialog. Preserve local-agent pairing separately. Do not fabricate email invitation delivery or unsupported Slack settings.

- [x] Observe Slack settings, member table, filters, owner actions and invitation pages in Brave.
- [x] Inspect Space workspace contracts/store/routes/settings and member/agent UI through CodeGraph and focused source reads.
- [x] Add failing directory integration and UI tests.
- [x] Add a permission-aware directory API and existing-account email resolution.
- [x] Implement member table, filters, paging and confirmed mutations; retain agent pairing.
- [x] Implement expandable workspace settings and role-permissions information.
- [x] Run focused React, Chat and API regression tests, build and typecheck.
- [x] Inspect the running member UI in Brave and fix the observed search alignment issue.
- [x] Record direct Slack observations, Space adaptations and remaining gaps in docs/architecture/slack-workspace-research.md.

The shared checkout contained unrelated edits and active concurrent work. No commit, push or deployment is included.


## Expanded scope after “build all”

User deferred SSO/billing. Implemented migrations 044–047 and connected persisted settings, icons/slugs, default channels, configurable invitation/channel/email policies, verified-domain entry, invitation lifecycle/SMTP delivery, guest access, primary ownership transfer, sorting/CSV export and event-driven retention. Added explicit destructive-retention confirmation. Preserve existing agent management and unrelated shared-tree work.

Verification adds isolated concurrency/security tests, email verification callback coverage, real scheduled-broker retention consumption and Brave inspection. Local database migrated through047; retention remains opt-in. No production deployment, commit, push or external email delivery.
