# Slack workspace settings and member management

Observed on 2026-11-04 in Brave, in an authenticated Slack Free workspace. These are live UI observations, not REA shipped-code evidence: the REA MCP was unavailable and its doctor reported an unsupported local Node version and missing registration. Slack settings and membership were not changed.

## Reference surfaces

- Workspace client Admin menu: Workspace settings, Edit workspace, Manage members, Apps & workflows, analytics and billing-related links.
- [Settings & Permissions](https://sammyshop.slack.com/admin/settings): separate administration page with left navigation; Settings, Permissions, Authentication and Attachments tabs; descriptive setting rows with Expand buttons.
- [Manage members](https://sammyshop.slack.com/admin): member table, invite button, search by name/email/ID, filters, per-person overflow menu, sortable name/date columns and member export.
- [Invitations](https://sammyshop.slack.com/admin/invites): Pending, Accepted and Invite Links tabs. The invite dialog has Email and Invite link methods, optional channel selection and a Send action.

The reference workspace contained only its primary owner. That owner's menu offered profile editing and ownership transfer. Admin/member deactivation menus were not directly observable in this account, so this implementation does not claim they were exercised in Slack.

## Initial comparison and first implementation

| Area | Slack observed UI/behavior | Space before | Space after the initial pass |
| --- | --- | --- | --- |
| Entry points | Admin menu links to dedicated settings and people administration | Admin links opened a rename form or combined people/agents list | Existing Admin links now open expanded settings or member administration; agent pairing remains available |
| Settings layout | Tabs, descriptive rows, explicit edit/expand actions | Single always-visible name input | Settings and Permissions tabs, expandable name editor, Save/Cancel, save feedback, workspace information and link to members |
| Settings authority | Workspace-wide administrative controls | Owner/admin checked by API and form | Same authority; members see a read-only explanation, live role changes remove editing controls |
| Directory | Dense table with search and filter controls | Human names mixed with agent connection statuses | Table with name/ID, administrative email column, account type, active/deactivated state and join date |
| Search and pagination | Name/email/ID search, account filters, sortable columns | No human management search | Server-side name/ID search; managers can search email; account-type/status filters; 25-person pages using UUID cursors |
| Account actions | Per-person overflow actions depend on target/current user; primary owner has transfer ownership | Role change, removal and reactivation APIs existed but no human management UI | Confirmed role change, deactivation and reactivation; existing server authorization and last-owner safeguards remain authoritative |
| Adding people | Email invitation or invite link, optional channel assignment | Add-member API required user ID | Add an existing Space account by email as a member; explicitly called Add people, with no claim that email was sent |
| Agent management | Separate app/admin concepts | Local agent pairing in member dialog | Preserved behind Agents & connections; existing pairing tests remain unchanged |
| Recovery | UI observation did not establish Slack's transport | Existing workspace event subscription | Reuses event-driven workspace subscription and reconnect/focus catch-up; no recurring resource scans |

The Space screens adapt Slack's information hierarchy to the existing themed dialogs and design system. They are not pixel-identical copies of Slack's separate light admin website.

## Expanded workspace implementation

The follow-up request was to build the remaining workspace features. SSO and billing were explicitly deferred by the user.

| Area | Implemented behavior |
| --- | --- |
| Workspace identity | Name, safe PNG/JPEG/WebP icon, description, unique canonical slug and `/w/:slug` entry route. The switcher displays configured icons. |
| Settings | Default public channels, approved exact email domains, language preference, display-name guidance, email visibility, invitation permission and channel-creation permission. All changes require owner/admin authority and an optimistic revision. Language is a saved preference; the interface remains English. |
| Invitations | Email-bound invitations and bounded reusable links; pending/accepted/expired/revoked states, expiry, use limits, resend/token rotation, revoke, optional channel assignment and authenticated acceptance. Pending/Accepted/Invite links tabs follow Slack's observed organization. |
| Email delivery | Optional SMTP, encrypted durable invitation jobs, bounded retries and status reporting. Email invitations require a matching verified account; the verification callback and UI are connected. Without SMTP, bearer invite links work and email-delivery unavailability is explicit. |
| Guests | Single- and multi-channel guests are assigned channels. They cannot create/join arbitrary channels or invite/manage people. Directory, DM initiation and mention discovery are scoped to shared-channel contacts. Existing direct conversations remain accessible. Conditional membership writes enforce single-channel assignments across races. |
| Ownership | The primary owner can transfer ownership to an active full member. Primary owners cannot be deactivated/demoted before transfer; the old primary remains an owner. |
| Directory | Name, join-date and ID sorting; role, guest and active-status filters; bounded cursor pages. Join-date cursors preserve PostgreSQL microseconds. Owner/admin CSV export is capped at 10,000 people and escapes spreadsheet formulas. |
| Domain joining | Verified exact approved domain required; default public channels assigned transactionally. Domain joining cannot reactivate a deactivated account. |
| Retention | Opt-in message-content/shared-file expiry, immutable replay erasure, source-linked todo erasure, durable file deletion and bounded historical backfill. Shortening retention requires explicit confirmation. Message tombstones and task audit records remain. |

Space adapts Slack's hierarchy to themed dialogs. This is implemented workspace scope, not a claim of complete Slack product parity. Enterprise authentication, SSO and billing are not included. Slack-specific settings outside this scope, such as plan administration, are not presented as implemented controls.

## Operational and security boundaries

Migrations 044–047 add workspace preferences, invitations, primary ownership/guest constraints and retention. The local development database was migrated through 047. No existing workspace was opted into retention, no real invitation emails were sent, and no production deployment was performed.

The new settings, invitation, ownership and retention paths use transactions, constraints, conditional writes and bounded serializable retries. They add no recurring resource scans, distributed locks or explicit database locks. Older workspace/channel operations still use their existing explicit locks; this change preserves their guarantees and does not resolve that separate migration gap. Ordinary PostgreSQL write locks still exist.

Runtime prerequisites are PostgreSQL, NATS JetStream, the WAL/CDC event bridge and the API consumers. File deletion obligations persist until storage is configured and removal succeeds. Retention erases server message content and referenced shared files, not task audit records or copies made outside that scope.

SMTP configuration is documented in `.env.example`. Delivery is at least once: a crash after SMTP accepts a message can cause a duplicate with the same Message-ID. Raw invitation tokens are shown only on creation/resend and held in UI memory; saved records contain token hashes, and queued email tokens are encrypted. Request logging redacts invitation URLs. Save/copy a generated link before closing its result panel.

The email-verification callback follows [Better Auth's email verification API](https://better-auth.com/docs/concepts/email). Verified email is required for email-bound invitations and domain joining; a bearer invite link intentionally grants its configured access to any authenticated holder.

## Verification

Automated coverage includes settings authorization and concurrent saves; slug uniqueness; exact verified domains and deactivated exclusion; guest channel/DM/directory/mention restrictions; ownership transfer; microsecond pagination; CSV escaping; invitation expiry/rotation/revocation/usage races; encrypted email jobs and bounded retries; verification links; retention policy changes, duplicate expiry, replay/todo erasure and storage retry.

A real NATS test publishes a SQL-trigger-produced retention deadline, closes the publisher, then starts the registered API consumer and verifies committed redaction. Its boundary is outbox payload → broker → API consumer → database; it does not independently prove the WAL bridge. Other integration checks require the existing local bridge to be running.

Brave inspection verified expanded settings, permissions, member filters/primary-owner labeling and invitation forms in the local app. Visual checks corrected dark-theme surfaces and invite-form overflow. Live settings were not changed during visual inspection. These are local functional checks, not production load or availability measurements.
