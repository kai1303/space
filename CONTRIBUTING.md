# Contributing to Space

Setup feedback, accessibility reports, documentation edits, and focused fixes are welcome. Search the [open issues](https://github.com/kai1303/space/issues) for related work. For a larger feature, describe the workflow you want to improve so contributors can discuss scope before implementation. [Issue chooser](https://github.com/kai1303/space/issues/new/choose) · [Module roadmap](docs/architecture/module-roadmap.md)

For a suspected vulnerability, follow the [security reporting policy](SECURITY.md). Project discussions follow the [code of conduct](CODE_OF_CONDUCT.md).

## Making a change

1. Fork Space and create a branch from `main`. Follow the [quick start](README.md#quick-start) to run a local workspace.
2. Keep the change focused. For changes to storage, events, or retries, follow the [architecture principles](docs/architecture/principles.md) and cover the relevant failure or concurrency case. For web changes, check [frontend ownership](docs/architecture/frontend.md).
3. For code changes, run `pnpm build`, `pnpm typecheck`, and the tests for the affected area. For web and shared UI changes, run `pnpm test:ui`. The [development guide](README.md#development) covers integration test setup.
4. Open a pull request against `main`. Describe the observable change, link any related issue, and list what you verified. For a visual change, include a screenshot or a short recording with sample workspace data.
