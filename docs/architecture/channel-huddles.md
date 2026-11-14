# Huddles

Channel headers offer **Start huddle** or **Join huddle**. The join dialog lets people join muted; cameras always start off. One persistent panel owns the LiveKit room across channel navigation. It offers audio, camera, screen sharing, device selection, minimize, and leave. The Huddles destination offers teammate invitations, suggested channels, open rooms in 50-item pages, and the 20 most recent ended rooms the viewer was admitted to. A DM invitation appears across the recipient’s signed-in sessions, including on reconnect. A channel huddle participant can invite an existing channel member. Dismissal and admission clear the invitation across devices. Invitations refer to a specific live room so following an expired invitation cannot start a new one. Channel and DM headers also offer a permanent link to the prejoin dialog. When the starter can post, activation creates a single conversation thread which stays accessible after the room ends. Encrypted DMs keep their audio invitation and omit the plaintext thread. Rooms allow 12 simultaneous participants. Rejoining from another device with the same user identity replaces the previous connection.

## Run locally

The optional media service uses the pinned LiveKit server image. Its credentials are public development defaults and its ports bind only to localhost. Keep the existing database, NATS and event bridge running.

```sh
docker compose -f compose.huddles.yaml up -d
pnpm --filter @space/contracts build
pnpm --filter @space/postgres build
pnpm --filter @space/events build
pnpm --filter @space/server build
node --env-file=.env scripts/dist/migrate.js

PORT=3002 BETTER_AUTH_URL=http://127.0.0.1:5175 \
AUTH_TRUSTED_ORIGINS=http://127.0.0.1:5175 \
LIVEKIT_URL=http://127.0.0.1:7880 \
LIVEKIT_PUBLIC_URL=ws://127.0.0.1:7880 \
LIVEKIT_API_KEY=space_local \
LIVEKIT_API_SECRET=space_local_huddle_secret_do_not_deploy \
node --env-file=.env apps/server/dist/main.js
```

In another terminal:

```sh
SPACE_API_URL=http://127.0.0.1:3002 pnpm --filter @space/web dev --host 127.0.0.1 --port 5175 --strictPort
```

The separate ports preserve the usual development server. The local webhook points to API port 3002. Change `config/livekit.local.yaml` if using another port. Open `http://127.0.0.1:5175/chat`, select a channel, then Start huddle. Without LiveKit configuration, the Huddles page explains the missing configuration and channel call buttons stay hidden.

If the container runtime cannot reach host-loopback webhooks, run a native LiveKit server with `--config config/livekit.native.yaml` instead of the container. The verified local preview uses this option. A binary was built from the official `v1.13.11` source into `/tmp/space-huddles-livekit/livekit-server`. To restart this preview's media service:

```sh
docker compose -f compose.huddles.yaml stop livekit
/tmp/space-huddles-livekit/livekit-server --config config/livekit.native.yaml
```

For a fresh machine, download the source archive from `https://github.com/livekit/livekit/releases/tag/v1.13.11`, extract it outside the Space checkout, and run `go build -o /path/to/livekit-server ./cmd/server` in that source directory (Go 1.26+). Both supplied configs keep automatic room creation disabled.

## Authorization and recovery

Space issues 60-second, room-scoped JWTs after verifying active workspace membership, joined channel membership and an unarchived channel. No media API secret reaches the browser. Join tokens allow media publishing/subscription, and room-scoped data publishing for transient reactions. Room names and participant identities are opaque UUIDs. The SFU enforces the 12-participant cap. Signaling and media do not flow through Socket.IO or PostgreSQL.

A partial unique index admits one open huddle per channel. Concurrent starts converge on that room; atomic authorization writes protect starts racing membership revocation. Transactions retry serialization/deadlock failures at most four times. These use ordinary PostgreSQL transactions/internal write locks, with no explicit row locks or distributed lock service.

Provisioning and closing obligations are written to the existing transactional outbox. The event bridge publishes them into NATS; API consumers process four at a time. HTTP media work has a separate four-operation, 32-queued-request budget. Provider requests time out after eight seconds. Failed durable media operations make at most eight attempts, 30 seconds apart. Exhausted obligations are retained under `huddle_failure.*` in the durable WORK stream, and the API logs `huddle_media_retry_exhausted`. Alert on this subject and replay the stored `operation` with its same huddle ID and a new event ID after restoring the provider. There is no automatic scan of failed work. A failed close requires this recovery before media revocation is complete.

Workspace membership revocation, channel departure, archive/privacy changes, or channel deletion end affected huddles. All participants must rejoin a newly created huddle after such a change. Cleanup is asynchronous: availability of the event bridge, broker, API consumer and SFU determines how quickly a removed member is disconnected. This is not an instantaneous revocation guarantee during outages.

**Self-hosted LiveKit must have `room.auto_create: false`.** Removing a participant alone does not invalidate an old self-hosted token. Ending and deleting the entire unique room prevents old tokens reopening it. Provisioning rechecks state after creation and deletes rooms revoked during creation. Redelivery repairs crashes between the media side effect and its state check. Never reuse a huddle ID for a new room.

LiveKit's raw-body signature authenticates `/v1/huddles/webhook`; Space's cookie auth is bypassed only for that independently authenticated route. `room_finished` is a monotone terminal update, so duplicate or reordered callbacks cannot reopen a session. There is no recording or transcript storage. If the final callback is missed, the next join checks room existence, ends stale state, and asks the user to start again. The listing can temporarily show that stale room until the next join; no recurring reconciliation scan runs.

Frontend discovery uses the existing authenticated Socket.IO resource subscriptions and persisted revisions. Reconnect/focus revalidates state; authorization loss disconnects local tracks. Media reconnect is handled by LiveKit. Navigating between channels or minimizing the panel does not disconnect audio; sign-out and provider unmount stop tracks.

## Deployment and verification

For a reachable deployment use unique secrets, HTTPS/WSS, a correct advertised RTC address, and TURN for restrictive networks. Configure signed webhooks and run the outbox bridge/NATS consumers. The localhost Compose file is not a production deployment.

Tests cover concurrent starts, access denial, revocation during provisioning, overlapping revocation/start, duplicate terminal updates, missing-room recovery, and durable cleanup across two API instances. Browser component tests cover join/cancel races, mute defaults, minimizing, cleanup and revoked discovery. The optional actual-media test connects three clients and receives non-silent synthetic audio plus camera/screen frames; it also tests stale-token rejection after room deletion.

```sh
cd tests
node --env-file=../.env --import tsx --test integration/huddles.test.ts integration/huddles-realtime.test.ts
# Supply the four LIVEKIT_* variables above for the real media test:
node --import tsx --test e2e/huddles-media.test.ts
```

Cross-network TURN behavior and physical microphone/camera permission flows require testing on the target deployment and devices. The media test uses synthetic frames and does not access a microphone, camera or desktop capture.
