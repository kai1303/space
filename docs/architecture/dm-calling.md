# Direct message audio and video calls

Space supports one 1:1 call at a time per user, across workspaces and devices. Open a two-person DM and use the voice or video button. A video call begins with a local preview. Recipients can answer with audio, or preview their own camera and explicitly answer with video. Camera/microphone tracks are acquired only after a user action. The call panel survives navigation; mute, camera toggle, input-device selection, minimize and hang-up are available. Call history shows the latest 20 calls in a DM. Self-DMs cannot call.

## Configuration and rollout

Apply migration 051 and restart the event service and API with the rebuilt packages before enabling the new web client. The event adapter adds `call.>` work subjects and transient Core NATS subscriptions; all API instances and CDC publishers must use the new version. Existing Socket.IO transport, authentication and bounded database work are shared. Redis is not required for calling.

Serve the browser over HTTPS (localhost HTTP works for development). Configure ICE on the API:

```dotenv
CALL_STUN_URLS=stun:relay.example.com:3478
CALL_TURN_URLS=turn:relay.example.com:3478?transport=udp,turns:relay.example.com:443?transport=tcp
CALL_TURN_SECRET=<server-side TURN REST shared secret>
CALL_ICE_RELAY_ONLY=false
```

Use a TURN service supporting coturn's shared-secret REST authentication (`use-auth-secret`, `static-auth-secret`), or self-host coturn. The API returns user-scoped HMAC-SHA1 credentials valid for one hour. The secret never reaches the browser. Reconnecting refreshes ICE configuration; an active call renews credentials five minutes before expiry using a specific credential deadline with bounded retries. Configure relay bandwidth/connection quotas, blocked internal/loopback peer ranges and public relay ports on TURN. TURN is infrastructure outside the Space API; adding environment variables does not provision it. Empty ICE settings support reachable local peers but do not prove internet connectivity. TLS on port 443 helps restrictive networks; test the actual deployment/firewall.

Direct connections expose network addresses to the other participant. Set `CALL_ICE_RELAY_ONLY=true` when direct address disclosure is undesirable; it requires TURN and increases relay traffic. WebRTC encrypts media between the two clients, including when TURN forwards it. Space stores call metadata, never recordings or SDP/ICE. Authentication trusts Space's signaling service; this is not independently verified peer identity.

The desktop shell prompts for capture permissions only on the configured Space origin. Packaged macOS builds include camera/microphone usage descriptions. Operating-system permission denial remains visible as a capture error. Browser/OS permission prompts and actual hardware require manual validation on the supported targets.

## Ownership and recovery

`features/calling` owns the UI and session controller; `Chat.tsx` composes it under the authenticated `SocketSession`. Navigation does not create a new call owner. Each tab creates an unpredictable private resumption capability, stored only in its controller memory and the server; snapshots, history and commands return a server-computed `selected` boolean and never expose either endpoint capability. One device wins acceptance using serializable transactions; there is no ownership transfer or takeover lease. The active participant uniqueness constraint prevents simultaneous calls. Conditional membership writes order admission against revocation without explicit database locks. PostgreSQL still takes normal internal write locks.

Lifecycle changes and targeted hints commit together through `event_outbox`, WAL and JetStream. A durable 30-second ringing deadline creates a missed call. Accepted endpoints send a presence heartbeat every 15 seconds; a targeted 45-second deadline terminates an abandoned call and frees both participants. These are protocol liveness writes for an identified call, not recurring resource/queue scans. Old deadlines recheck current state and never expire fresh presence. API restarts do not discard deadlines. Membership removal ends affected calls transactionally.

Each API subscribes to transient NATS signaling. Messages are authorized on send and delivery, expire after 10 seconds, and target the selected device. SDP is limited to 32 KiB, ICE candidates to 2 KiB, and signals to 256 per socket per 10 seconds. Socket operations use the existing bounded work queue. A slow/offline browser recovers authoritative state after resubscription; stale signaling is not replayed.

The caller owns SDP offers for two reserved send/receive media slots. The callee binds its local tracks to those slots after receiving the offer. This avoids competing initial offers and permits camera changes via `replaceTrack` without renegotiation. Duplicate ready messages resend the pending offer; generation checks reject stale answers. The ICE buffer is capped at 128 candidates across two generations. Initial connection/recovery has a 30-second deadline and at most two caller ICE restarts. Losing application signaling stops capture after 25 seconds; server presence expiry handles crashed clients. A deliberately modified P2P client cannot be forced to stop sending media by revoking Space signaling alone.

No group calls, screen sharing, recording, offline push ringing or cross-device call transfer is included. Long-running calls and TURN credential renewal need deployment testing. Background suspension on mobile browsers may end a call through the liveness deadline.

## Verification

```sh
pnpm --filter @space/contracts --filter @space/events --filter @space/postgres --filter @space/server build
TEST_DATABASE_URL=... pnpm --filter @space/tests test:calls
TEST_DATABASE_URL=... pnpm --filter @space/tests test:calls:e2e
pnpm --filter @space/web exec vitest run src/features/calling src/app/Chat.test.tsx
pnpm --filter @space/desktop test
```

Integration tests use isolated PostgreSQL schemas, real CDC/NATS and two API instances. Browser tests use two authenticated Chromium contexts with synthetic camera/microphone sources and actual RTCPeerConnections. This verifies media transport, not real hardware or internet traversal. Before production, exercise separate networks, relay-only TURN, denied permissions, device removal, Wi-Fi changes and Safari/Firefox plus the packaged macOS app. Measure connection success/time, relay percentage and bandwidth under the expected load before making capacity claims.

### Local verification on November 4, 2026

The direct and forced-relay two-browser tests passed. The relay test used an isolated, loopback-only coturn 4.6.3 container with synthetic media; both clients' selected candidate statistics reported `relay`, and incoming video frames were decoded on both clients. The test relay was stopped after verification. This validates the shared-secret credential and relay integration, not a production relay version or internet deployment. To repeat against a test relay, set `CALL_TURN_URLS`, `CALL_TURN_SECRET`, and `CALL_ICE_RELAY_ONLY=true` when running `test:calls:e2e`; the test asserts the selected local candidate type.
