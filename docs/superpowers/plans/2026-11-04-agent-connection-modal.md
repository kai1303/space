# Agent connection modal

**Goal:** Make agent setup a direct, focused flow with accurate local and cloud connection instructions.

**Design:** Open Connect an agent directly from the agent catalog. Separate connection method, connector choice, pairing, and existing agent connections. Use the existing Dialog, button, typography, color tokens and realtime subscription. Cloud runners use trusted registered connectors and the current pairing protocol; hosted endpoints show the existing operator configuration boundary. Pairing never grants channel or memory access.

**Implementation:**
- [x] Add regression coverage for direct catalog navigation, connector preselection, cloud instructions, unavailable cloud setup and pairing cancellation.
- [x] Redesign WorkspaceMembers and its colocated styles; preserve expiry, revocation, realtime updates and workspace cleanup.
- [x] Wire the catalog and Spacebot connect actions directly to setup, preserving member management for people.
- [x] Make trusted cloud connector registration available to the server entrypoint and document its deployment/protocol requirements.
- [x] Run focused UI/config tests, typecheck/build, then inspect the running modal at desktop and narrow widths.

**Boundaries:** No new cloud hosting service, provider inference, public endpoint registration or arbitrary URL fetching. Existing AG-UI long-running execution limitations remain explicit. Preserve unrelated in-progress Spacebot changes.

**Validation:** 31 focused web tests and 2 cloud configuration tests passed. Shared UI build, web typecheck/build and server build passed. Browser checks confirmed direct opening, provider selection, cloud empty state and 390px layout without horizontal overflow. No live cloud-provider execution was performed.
