# Shared Select Implementation Plan

**Goal:** Replace all 33 visible native production dropdowns with one accessible, themed Select, including search for long lists.

**Architecture:** A shared `@space/ui/primitives` Select renders a combobox trigger and bounded listbox popup. It accepts existing option children and change handlers; a hidden native select preserves browser form validation and submission. Popups stay inside the closest dialog/popover to preserve nested focus and dismissal. Short lists support typeahead; long lists expose search. The standalone gallery HTML sample remains a self-contained browser document.

**Tech stack:** React, TypeScript, existing Phosphor icons, Vitest and Testing Library; no new dependencies.

- [x] Add focused failing tests for keyboard selection, search, dismissal, disabled fieldsets, required validation, dynamic options and form data.
- [x] Implement `packages/ui/src/primitives/select.tsx`, export through primitives and root, and add shared styles in `packages/ui/src/styles/styles.css`.
- [x] Replace native select JSX in all 16 feature files, preserving values, handlers, option labels and disabled/required props. Set explicit accessible names and searchable long-list controls.
- [x] Update feature tests to interact with the visible listbox. Remove obsolete native-select CSS and preserve sizing around controls.
- [x] Run UI/web tests, typechecks and builds. Inspect browser rendering and review the final diff without disturbing existing Spacebot work.

## Verification

- UI library: 188 tests passed, including 8 Select behavior tests.
- Browser: standard selection and searchable timezone selection checked with keyboard input; light and dark appearances inspected.
- UI build and web production build passed. Full web suite: 387 passed, two chat startup waits failed; isolated rerun passed all 69 chat tests, including both earlier failures. The current agent-connection screen passed its 11 tests and final web typecheck passed.
- Current feature tree has 34 shared Select sites and no raw native select JSX. Concurrent agent-connection work adopted the shared component for its two controls.
- Native select remains only as the hidden form backing control and inside the standalone gallery HTML document.
