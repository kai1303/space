# Spacebot renderer provenance

The Spacebot avatar replaces the earlier Slack-inspired bot mark with the Purple Circle / Attentive renderer inspected at https://grokbots.ai/studio?face=attentive&color=purple on 2026-11-04.

`spacebot-engine.ts` preserves the captured pure geometry and pose definitions. The website bootstrap is removed; a private local module adapter resolves only its fixed numeric math/preset modules. No remote scripts, authentication, analytics, site UI, network calls or eval are included. The vendor section is mechanically recovered JavaScript with a typed public boundary. Handwritten React lifecycle/rendering lives in `spacebot.tsx`.

Captured engine source: https://grokbots.ai/_next/static/chunks/1imge0o17l0k9.js

SHA-256: `394db3bacd5ca153a28dcb05ca319679f1215756b07d9fa219761281a5ddac5b`

The shared source's pointer mapping and Studio frame cadence are reproduced in the component: 16 degrees horizontal gaze, 13 degrees vertical gaze, 850ms gaze introduction, 240ms gaze easing, 450ms shape/expression morphs, 48ms idle sample spacing and 50ms maximum time delta. The original 8 shapes, 16 faces and 15 poses remain available. Transient poses return to idle after their original `max(maxMorph, minDuration ?? duration)` playback deadline. Main preview geometry uses the original 316-unit padded viewBox; navigation uses the exported avatar's tighter 250-unit framing for legibility.

The React component owns its sampled geometry so animation does not update parent/chat state. Offscreen, document-hidden and reduced-motion instances do not run an animation frame loop. Observer, listener, frame and transient-pose deadline cleanup is tested. Dark rail eye cutouts use the source dark paper colour; the welcome avatar follows Space's surface token.

This ports the avatar renderer, not the Studio page's export/settings UI. No association with Grok Bots or xAI is implied. Research evidence and formatted source are retained in `/Users/kai/.codex/artifacts/grokbots-studio-2026-11-04`.
