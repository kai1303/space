# Authentication with Better Auth

Better Auth 1.7.15 handles email/password accounts and cookie sessions in the
existing Fastify server. Its Drizzle adapter uses PostgreSQL. The React client uses
`better-auth/react`; HTTP and Socket.IO both authenticate the same session.

## Run

```sh
pnpm install --frozen-lockfile
export DATABASE_URL=postgres://workplace:local_demo_only@127.0.0.1:55438/workplace
export REDIS_URL=redis://127.0.0.1:56380
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export BETTER_AUTH_URL=http://127.0.0.1:5173
export AUTH_TRUSTED_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:5174
export TRUSTED_PROXY_CIDRS=127.0.0.1,::1
docker compose up -d postgres redis
pnpm migrate
pnpm server                       # terminal 1
pnpm worker                       # terminal 2, same database/Redis URLs
pnpm web                          # terminal 3; visit /chat
```

Keep the generated secret stable and private between restarts. The secret must be
at least 32 characters; use a random value rather than a memorable phrase. The app
requires `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` on startup. These settings are
forwarded by Turbo. `.env.example` documents all variables but does not contain a
working shared secret. For this session's local preview, private settings are in
`.env.auth-local`; start it with `node --env-file=.env.auth-local apps/server/dist/main.js`.

The base URL is the **browser-facing origin**, not an internal container address.
The browser uses `/v1/auth`; Vite proxies `/v1` and `/socket.io` to the backend.
Cookie requests stay on the same origin, so no permissive CORS configuration is
needed. Register an account, then create your own workspace or ask an owner to
add your user to an existing one. Existing workspace APIs remain authoritative.

## Sessions and permissions

- Passwords are hashed by Better Auth. Password length is 12–128 characters. The app
  never implements its own password hashing or stores passwords in frontend storage.
- A session lasts seven days with a fixed expiry. Cookie caching and sliding refresh
  are disabled, so API/socket checks read current server-side session state.
- Cookies are HttpOnly and SameSite=Lax, with Secure enabled for HTTPS. Production
  configuration rejects an HTTP base URL. Local Docker Compose explicitly selects
  development mode for its localhost HTTP setup; the image itself defaults to production.
- Sign-out revokes the current session. Better Auth also exposes session listing,
  individual/all-session revocation and password change. Sign-out/revocation sends
  a transactional invalidation through committed WAL and NATS JetStream. Every socket
  command and event-triggered delivery checks the current session, including sockets
  without a channel subscription. Broker reconnect reattaches the consumer and
  rechecks connected sessions; no periodic authentication scan runs.
- A new session for the same user recreates the chat connection. Revoked/expired
  sessions clear chat and refresh the session UI. Slow-connection errors retain
  their existing replay/reconnect behavior.
- Auth endpoints retain Better Auth's origin protections. Custom cookie-authenticated
  mutations require an Origin from the explicit allowed list. Browser WebSocket
  origins must also match that list. Native clients may omit Origin on socket
  handshakes but still need a valid session cookie.
- Authentication does not grant workspace, private-channel, agent or
  approval permissions. Existing membership/ownership checks remain in place.
  Self-registration never joins an existing workspace or claims another user ID.

## Rate limits and proxies

Better Auth's database-backed limiter is enabled in development and production:
100 auth requests/minute, with 10 email sign-in attempts and 5 email sign-ups/minute
per IP/path. Database storage shares limits across API processes.

The Fastify handler overwrites the internal IP header using `request.ip`. Client
supplied forwarding/IP headers are ignored unless the request comes through an
explicitly trusted proxy. Set `TRUSTED_PROXY_CIDRS` to the exact IPs/CIDRs of proxies
you control, never a blanket trust setting. Vite forwards client IPs; the local
example trusts loopback only. In a container deployment use the actual controlled
proxy address. With proxy trust unset, users behind a proxy share its rate-limit
bucket. The application provides no automatically trusted public proxy network.

## Data migration and compatibility

Migration 006 adds account, session, verification and rate-limit tables. Existing
`users` gain nullable email and profile/auth metadata while retaining their UUIDs,
messages, roles and memberships. Registered emails are case-insensitively unique.
Better Auth's name field maps to `display_name`; new UUIDs use the existing format.

Legacy demo/operator users have no invented email or password and are not
automatically linked to registrations by name. Their history and credential rows
remain intact. Legacy bearer tokens are **disabled by default**. Old operator demos
can opt in with `ALLOW_DEVELOPMENT_TOKENS=true` outside production; startup rejects
that setting in production. The browser has no legacy-token login form. Use a
separate, explicit identity-migration process before converting real legacy users.

## HTTP contract

Better Auth owns `/v1/auth/*`. The browser uses its client rather than hand-written
auth requests. Notable endpoints:

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/auth/sign-up/email` | `{name, email, password}`; registers and signs in |
| `POST /v1/auth/sign-in/email` | `{email, password}`; returns session cookie |
| `GET /v1/auth/get-session` | Current session/user or null |
| `POST /v1/auth/sign-out` | Revokes the current session |
| `GET /v1/auth/list-sessions` | Current user's sessions |
| `POST /v1/auth/revoke-session` | `{token}`; revokes an owned session |
| `POST /v1/auth/revoke-sessions` | Revokes all of the user's sessions |
| `POST /v1/auth/change-password` | `{currentPassword, newPassword, revokeOtherSessions}` |

For command-line cookie clients, maintain a cookie jar and send a configured Origin
on mutations. An Authorization bearer header is not a Better Auth session.
Do not expose session/account tables or raw tokens in application logs.

## Boundaries and validation

Email verification and password-reset email delivery are not configured; OAuth and
MFA are not included. Newly registered email addresses remain unverified and are
not used to authorize existing workspace membership. Configure a mail provider
and the corresponding Better Auth flows before relying on verified email identity
or self-service password recovery. Existing agent integration remains the mock
connector; the authentication change does not enroll external agents.

`pnpm test:auth` uses disposable PostgreSQL schemas and covers hashing, login,
logout, expiry/revocation, cookie/socket identity, membership isolation, origin
checks, forged IDs/verification flags, rate limits and Secure cookies. Frontend
tests cover forms, failed logout, session restoration and same-user session rotation.
Local browser smoke covers registration, own workspace/channel creation, chat,
reload, logout and re-login. These checks are not a production deployment/load test.

Primary references:
[Fastify integration](https://better-auth.com/docs/integrations/fastify),
[Drizzle adapter](https://better-auth.com/docs/adapters/drizzle),
[session management](https://better-auth.com/docs/concepts/session-management),
[rate limiting](https://better-auth.com/docs/concepts/rate-limit).
