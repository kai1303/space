# Connected agents inherit their owner's conversation access

User policy: "connected agent permission = user permission". A connected agent needs no separate channel skill grant wherever its owner currently has conversation access. Preserve active workspace membership, requester access, supported capabilities, enabled/nonrevoked installation, and owner approval. Nonconnected installations retain explicit grants. Channel-memory opt-in and memory read/write roles remain independent of task routing.

- [x] Test connected discovery, explicit/semantic routing, sessions and task delivery without grants; verify membership loss, revocation, workspace isolation and owner approval.
- [x] Apply inheritance consistently to Navigator, mentions, task eligibility, session skill selection and the channel-agent API; remove redundant grant dependency from opted-in memory access for connected agents.
- [x] Show inherited permission in agent UI instead of per-channel toggles. Keep legacy grant controls for nonconnected installations. Reject obsolete connected-agent disable toggles rather than pretending they revoke access.
- [x] Run affected integration/UI tests and builds, review authorization changes, document and refresh local services when idle.

Validation: 93 affected integration tests and 28 agent UI tests passed. Final focused run after resolving concurrent Sidekick policy changes: 25/25 (connected permissions, legacy foundation, local connector delivery, Sidekick). The worker concurrency and real WAL/NATS runtime tests also passed. Server/worker builds, web and test-package typechecks passed. Independent review findings (manual picker visibility, optional memory on DM delivery, legacy entries in DM pickers) were fixed with failing-then-passing regressions. No migration or new paid model evaluation was required for this permission change.
