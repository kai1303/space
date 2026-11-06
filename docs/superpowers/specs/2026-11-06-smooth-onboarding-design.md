# Smooth account and workspace onboarding

Approved in chat on 2026-11-06, including Motion (motion.dev).

New users move from account creation to a focused workspace-name form, then into the workspace. Returning users sign in and open their existing workspace. Both setup forms share the same logo, width, spacing and page background. App navigation is hidden until workspace membership has loaded and a workspace is selected.

Use the installed Motion library for short content and layout transitions, with no artificial waiting. Respect reduced motion and move keyboard focus to the new step. Keep form values on failure, show errors beside the form, announce pending operations and prevent duplicate submissions. Failed workspace discovery has an explicit retry and must not be mistaken for an empty workspace list.

Keep Better Auth, existing workspace APIs, invitation and workspace-address routes, and the keyed SocketSession/CallingProvider boundary. No new onboarding persistence, starter channels, backend changes or dependencies. Preserve the embedded AuthScreen contract.

Validate focused auth/workspace tests, the existing chat integration suite, web typecheck/build, and actual signup/sign-in/workspace creation in the local browser, including narrow layout and reduced motion.

Sign-in error refinement requested during implementation: clear inline error copy and indicator, associated invalid fields for credential rejection, stable submit-button placement, and stale feedback cleared when details are edited.
