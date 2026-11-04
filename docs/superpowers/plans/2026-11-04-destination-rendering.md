# Consistent destination rendering

Approved direction: Spacebot, Home, DMs and Activity share a short opacity-only page transition and retain their UI context when revisited. Preserve existing fresh authorized reads and event-driven subscriptions; do not cache hidden private-data pages.

- Add a shared destination transition using the existing Motion duration and reduced-motion support. Fade only on destination changes, keep shell mounted, and disable outgoing interaction.
- Retain per-workspace DM selection/filter state, Activity filters and scroll, and bounded conversation panel state. Keep drafts and session retry identity in the existing workspace-level client stores so leaving a page does not lose work.
- Repair Spacebot connection routing and Activity tab keyboard behavior from the preceding review.
- Add regression tests before changing behavior. Measure render counts for composer typing, page navigation and realtime updates; optimize only demonstrated unnecessary work.
- Preserve unrelated dirty edits. Run focused UI/web suites, builds/typechecks, independent read-only review and isolated browser checks. No commit, push or deployment.

## Verification

- Spacebot, Home, DMs and Activity use the same 140 ms opacity transition, with reduced-motion support. The shell stays mounted. Home remains mounted across workspace changes so its scoped channel snapshots continue to work; other workspace pages reset by scope.
- UI snapshots retain Activity/DM filters, sidebar scroll, selected DM, Spacebot choices and up to 32 recent conversation panel selections. Resource data still uses fresh authorized reads and existing event subscriptions on revisit.
- Session drafts, retry identity and accepted-document acknowledgments survive destination unmounts. Delayed navigation callbacks check page presence immediately when exit starts.
- Render measurements: typing adds zero history renders; badge-only changes went from two history renders to zero; an incoming message produced two history passes while retaining the existing row and editor DOM nodes.
- 129 focused web tests passed across eight files. Web TypeScript checking and the production build passed through the dependency-aware Turbo build.
- Isolated production-preview browser checks confirmed session/draft restoration, selected-DM restoration, Activity filters and keyboard tabs, and selected-agent connection routing. The preview tab/server were closed afterward; no test messages were sent.
