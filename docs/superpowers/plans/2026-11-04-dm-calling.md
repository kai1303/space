# DM audio and video calling implementation plan

**Goal:** Ship browser and desktop 1:1 DM calls with audio/video, explicit camera consent, persistent controls, and durable lifecycle recovery.

**Architecture:** PostgreSQL stores call lifecycle and active participants. Constraints and serializable transactions arbitrate simultaneous starts/acceptance. WAL/JetStream delivers targeted changes and deadlines. NATS Core carries bounded, expiring signaling without storing SDP. The signed-in React tree owns one call controller using the existing Socket.IO transport. WebRTC negotiates audio/video with STUN/TURN supplied by the server.

**Scope approved in chat:** audio/video DM calls; incoming invitation, audio-only answer, camera preview, mute/camera/device controls, hang-up, busy/missed states, one selected device, navigation survival. No group calls, recording, or screen sharing.

- [x] Contracts and store: add `packages/contracts/calling.ts`, migration `051_dm_calls.sql`, `adapters/postgres/calling.ts`. Test duplicate starts, reciprocal calls, multiple-device acceptance, participant authorization, stale expiry, cancellation races, and revocation in `tests/integration/calling.test.ts`.
- [x] Realtime: add `apps/server/calling.ts` and ICE configuration; integrate with authenticated bounded work, targeted outbox wakeups, ephemeral NATS signaling, durable deadlines, and API history. Test through two API instances with actual CDC.
- [x] Media: add `features/calling/peer.ts` and its tests. Implement caller-owned negotiation for two fixed media slots, bounded candidate buffering, generation checks, connection deadlines/restart, device replacement, and complete cleanup.
- [x] UI: add call provider/panel/buttons/history in `features/calling`; compose provider under `SocketSession`, add DM header buttons. Test permission failures, explicit video answering and teardown; run a two-browser fake-media integration test.
- [x] Desktop/config/docs: allow camera/microphone only for the configured Space origin with explicit consent, add macOS usage strings, document TURN shared-secret credentials and production limits.
- [x] Verification: build changed packages, run calling contracts/store/realtime/browser tests plus relevant existing realtime/UI/desktop checks. Record measured scope and remaining real-network validation.

## Lifecycle and recovery decisions

Calls are ringing, accepted, or ended with a reason. A 30-second ring deadline produces a missed call. Selected endpoints send presence heartbeats; a targeted deadline ends an abandoned call, never transfers ownership. Reconnect reattaches delivery then reads authoritative state; negotiation messages expire and are never replayed from storage. Call history is a separate bounded DM activity list. Server authorization changes terminate calls; clients stop capture on teardown or session revocation. Direct P2P cannot forcibly stop two malicious peers after authorization is revoked.

## Verification results

- Calling contracts/store/two-API CDC integration: 9 passed.
- Calling controller/media plus existing chat/realtime UI suite: 89 passed in the final run (the workspace contains concurrent chat changes).
- Existing DM/chat outbox backend regression checks: 13 passed.
- TURN configuration: 2 passed; desktop origin/permission policy: 5 passed.
- Two-browser real WebRTC test passed with direct connections and again with forced coturn relay; selected candidate statistics asserted `relay`. Covers video preview, audio/video in both directions, audio-to-video upgrade, mute/camera replacement, navigation, minimize without pausing playback, signaling reconnect, and capture teardown.
- Contracts, events, PostgreSQL, API and web builds passed; web/tests typechecks and diff whitespace checks passed. Vite reports existing third-party module directive warnings.
- Focused independent review found and resolved endpoint capability exposure; all client responses now omit capabilities and return only a selected-device boolean. Review found no remaining blocker in that fix.
- The temporary loopback-only TURN test container was stopped. No production TURN service was provisioned; real hardware, public-network traversal, long-duration renewal and packaged macOS capture remain manual deployment validation.
