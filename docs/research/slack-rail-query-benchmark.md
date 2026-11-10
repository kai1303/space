# Workspace rail preview request counts

A local Chromium run on November 10, 2026 compared two production web bundles using the same signed-in workspace fixture. The baseline was captured before the workspace query cache integration, on a checkout based on `42b54c8`. Each number counts HTTP GETs initiated by the browser under `/v1/`, including other mounted Home components. [Runnable benchmark](../../tests/evaluation/rail-query-benchmark.mjs)

| Step | Before | After |
| --- | ---: | ---: |
| Startup on Home | 20 | 19 |
| First pass over the rail and filters | 25 | 18 |
| First repeated pass | 13 | 0 |
| Second repeated pass | 13 | 0 |
| Reopen Files | 1 | 0 |
| Deliver a workspace change while Files is visible | 11 | 11 |
| Reopen Files, show empty Starred, return to all files | 3 | 1 |
| Star a file and show Starred again | 2 | 2 |

Each pass visits Spacebot, DMs, Activity, Files, To-dos and Admin without leaving Home. Spacebot switches from Overview to Agenda and back. DMs and Activity toggle Unreads twice. Files toggles Starred twice. The script waits for the expected contents and dismisses each panel with Escape. Hover and filter actions issued zero writes. The 13 GETs in each repeated baseline pass comprised three each for Spacebot, DMs, Activity and Files, plus one for To-dos.

The fixture renamed a file, then delivered a Socket.IO `updates.changed` event for the workspace. The open Files panel displayed its new name. Both bundles made one Files GET and ten GETs for the other mounted workspace readers. The final step checked an explicitly requested mutation. With the empty Starred result already observed, starring the file issued one POST, and selecting Starred then displayed the renamed file.

## Reproduce

Install the workspace dependencies, build the production web app and start a local preview from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm --filter @space/web... build
pnpm --filter @space/web exec vite preview --host 127.0.0.1 --port 4173 --strictPort
```

Run the fixture in a second terminal. Use the bundled Chromium engine or set `PLAYWRIGHT_CHANNEL=chrome` to use an installed Google Chrome, as in the recorded run.

```sh
pnpm --dir tests exec playwright install chromium
node tests/evaluation/rail-query-benchmark.mjs http://127.0.0.1:4173
```

The report contains counts per phase and request paths with filters. The fixture intercepts API requests and Socket.IO messages locally, uses synthetic identity and content, and blocks requests to other origins. Each run starts with a fresh browser context. Both repeated passes completed within the 30-second cache lifetime. Startup and first-pass totals can vary with startup requests, page focus and socket acknowledgments. Production latency, database load and traffic across multiple users require separate measurements.
