# Space design system implementation plan

> Execute inline in this session. User authorized continuing with the design system first. Preserve the existing uncommitted foundation.

**Goal:** Deliver reusable Slack-grounded tokens/components and a working gallery before application screens.

**Architecture:** Add `@space/ui` as a pnpm workspace package with typed React exports and compiled CSS. `@space/web` consumes it as the interactive gallery. Components accept data/callbacks and have no backend authority.

**Tech stack:** React 19, TypeScript, Vite, CSS custom properties, Lato, Phosphor, Vitest and Testing Library.

## Sequence

- [x] Record source measurements, adaptations, boundaries and acceptance checks in the design spec.
- [x] Add package manifests and build/test configuration, then install through pnpm.
- [x] Write and run failing interaction tests for tabs, composer validation/keyboard behavior, reactions and native controls.
- [x] Implement tokens, themes, primitives and workplace components until tests pass.
- [x] Build the gallery with searchable section navigation, token references and working component examples, including a conversation/thread pattern.
- [x] Run `pnpm --filter @space/ui test`, `pnpm typecheck`, `pnpm build` and `pnpm test:contracts`.
- [x] Run the gallery with `pnpm web`; inspect desktop/mobile, modal focus, keyboard navigation, menus, themes and messaging through the connected browser. Fix observed defects.
- [x] Document exact commands, component usage, evidence and remaining scope; leave the verified gallery running for review.

## Files

`packages/ui/src/tokens.css`: theme and geometry tokens. `styles.css`: accessible component styles. `primitives.tsx`: low-level controls. `conversation.tsx`: message/composer. `index.ts`: public exports. `components.test.tsx`: behavior tests. `apps/web/src/`: gallery shell, foundations, components and conversation pattern. `docs/design-system.md`: consumer guide and provenance. Root manifest/README: frontend commands.

## Verification requirements

Tests must prove whitespace cannot send; IME Enter cannot send; successful submission clears only after the consumer callback succeeds; Shift+Enter does not send; reaction callbacks are controlled by the consumer; tab focus tracks selection; form errors are connected to their input; loading buttons cannot submit. Browser verification must cover modal Escape and focus restoration, theme persistence, search/filtering, demo sending/thread rendering, responsive navigation and no horizontal page overflow at 390px and 320px.
