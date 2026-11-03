# Better Auth implementation plan

Goal: replace the chat's demo-token login with Better Auth email/password accounts
and cookie sessions, preserving organization/workspace authorization and history.
Status: implemented and locally verified. User explicitly selected
email/password only.

Architecture: Better Auth 1.7.15 runs in Fastify at /v1/auth through its Drizzle
adapter. It shares existing users by UUID; new sessions/accounts/verification/rate
limit tables are added in migration 006. Legacy users retain IDs, memberships and
history without fabricated email addresses. Public registration never claims an
existing identity or grants membership in an existing organization.

- [x] Add real-DB tests for registration, hashed passwords, valid/invalid login,
  session restoration/logout/expiry/revocation, denied bearer fallback, CSRF/origins,
  unchanged membership isolation, rate limits and Socket.IO cookie sessions.
- [x] Implement migration and schema, Better Auth configuration and Fastify handler;
  central session resolution for HTTP/socket. Use database-backed rate limits with
  a server-set client IP header. Require secret/base URL; secure cookies on HTTPS.
- [x] Disable legacy tokens by default; permit explicit development-only mode for
  old operator demos/tests. Retain their rows and data, with no automatic linking.
- [x] Build sign-in/sign-up/logout UI with Better Auth client. Use same-origin cookies
  for HTTP and sockets, restore sessions on reload, clear chat on logout/session loss.
  New users may create their own organization/workspace through existing APIs.
- [x] Update tests/config/Compose/Turbo/CI/docs; run full tests/build/typecheck and
  browser smoke check. Request an independent security-focused review.

Scope: email/password signup/login, persistent sessions, logout, session revocation,
password change through Better Auth, existing profile/membership permissions.
Email verification/password-reset delivery and OAuth require provider configuration;
no fake email sender or account linking by name is introduced. Unverified email is
not used to authorize organization membership. Organization plugin is unnecessary
because this project already has a tested hierarchy and access model.

Validation: temporary PostgreSQL schemas for auth tests; fresh per-test identities
and independent Cookie jars. Verify no password plaintext in DB/API and no auth
cookies accepted from untrusted browser origins. Socket sessions are rechecked on
commands and every reconciliation, including unsubscribed connections. Logout
publishes the existing Redis wake-up so other processes recheck sessions.


## Verification

- Full suite: 66 backend, 53 shared UI and 10 web tests passed (129 total).
- Typecheck and build passed. Existing Vite dependency/bundle warnings remain.
- Browser: email/password registration, own organization/channel creation, cookie
  authenticated chat, reload persistence, logout and re-login succeeded.
- Review findings fixed: explicit trusted-proxy handling for rate limits; recreate
  chat connections when a user's session ID changes.
- Legacy users/history preserved by additive migration 006; development tokens are
  disabled in the running local preview. No production deployment was performed.

Setup and boundaries: `../architecture/authentication.md`.
