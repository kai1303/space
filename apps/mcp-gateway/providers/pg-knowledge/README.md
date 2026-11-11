# pgGraph and pgContext knowledge provider

This Space external knowledge plugin serves one workspace from a dedicated PostgreSQL 17 database. It embeds a query locally with Ollama all-minilm:22m (384 dimensions), combines vector and full-text rankings with pgContext, and follows each matching passage's service to its owner with pgGraph. Runbooks and ownership records have independent HTTPS citations. The search returns the top 1–50 hits and supports nonempty text queries.

## Try the local pilot

From the Space repository root, with the pilot provider running:

```sh
node --env-file="$HOME/.config/space/pggraph/provider.env" apps/mcp-gateway/providers/pg-knowledge/smoke.mjs --agent
```

The deterministic checks call Space's actual knowledge discovery and search functions over MCP. They use two synthetic channels, one requester, an unknown requester, an unknown channel, the wrong workspace and an invalid bearer. The optional agent step uses local Ollama qwen2.5-coder:3b to choose a search query and select the supporting runbook and owner records. The harness renders those records with their original citations. The fixture's catalog.example links identify synthetic sources.

## Set up another installation

1. Build the database image with `docker build -t space-knowledge-postgres:17-graph1.2.1-context0.3.0 apps/mcp-gateway/providers/pg-knowledge`. Use a dedicated PostgreSQL database, persistent storage and `shared_preload_libraries=pg_cron,graph,pgcontext`. Install the schema once with `psql -X -v ON_ERROR_STOP=1 -f schema.sql` from this directory using an installer role. Assign a generated login password to `space_knowledge_reader`.
2. Start local Ollama and pull `all-minilm:22m`. Pull `qwen2.5-coder:3b` for the optional agent test. For the synthetic corpus run `python3 seed-demo.py` with the installer's PGHOST, PGPORT, PGUSER, PGDATABASE and libpq authentication set. The seed embeds documents, registers their point IDs and builds the graph. For real data refresh affected point IDs after passage updates and publish updated ownership projections with graph.build or the extension's sync API. Reads use the last published projection and independently check visible ownership rows.
3. Set KNOWLEDGE_DATABASE_URL to the reader login, KNOWLEDGE_WORKSPACE_ID to the workspace UUID, and KNOWLEDGE_BEARER to a generated secret of at least 32 characters. Keep the environment file owner-only. For the demo the workspace UUID ends in 0001 as recorded in seed-demo.py. Configure kb.access with explicit (workspace, requester, channel) grants. The pilot has two visibility levels. Only tuples with include_private=true can read private passages and ownership links. Review these grants when a channel's membership changes.
4. Build the workspace dependencies and gateway with `pnpm --filter @space/mcp-gateway... build`. Run `node --env-file=/absolute/path/to/provider.env server.mjs` from this directory. The provider listens at 127.0.0.1:58439/mcp.
5. For a gateway on the same machine, launch it with NODE_ENV=development and SPACE_LOCAL_PG_KNOWLEDGE=1. In **Agents & tools → Apps → Add MCP server**, choose **External knowledge plugin**, set the URL to `https://pg-knowledge.invalid/mcp` and use the provider's bearer. Test the connection and grant knowledge_search to the target agent. The dev gateway maps only this exact alias to the fixed loopback endpoint. For a deployed provider use its actual HTTPS endpoint behind a reverse proxy. The normal gateway still requires a public HTTPS destination.

To run a workspace provider alongside the synthetic pilot, give the second provider its own bearer and workspace ID. Set its `KNOWLEDGE_PORT` and the development gateway’s `SPACE_LOCAL_PG_KNOWLEDGE_PORT` to the same unused loopback port. Both default to 58439.

The database, model, provider and Space gateway are separate processes. The smoke test exercises the MCP integration independently of a paired Space chat session.

## Opt-in channel threads

Thread search is optional. Apply Space migration 082 and install `threads.sql` once in the provider database after `schema.sql`. Run one worker per workspace in a supervisor that restarts it on connection loss. Keep credentials out of the repository:

- In Space, give the ingestion login SELECT on `knowledge_thread_channels` and `knowledge_thread_messages`. Give the provider lookup login only EXECUTE on `knowledge_visible_messages(uuid,uuid,uuid,uuid[])`, plus the schema access needed to call it.
- In the index, give the worker login membership in `space_thread_collection`, USAGE on schema `graph`, SELECT/INSERT/UPDATE/DELETE on `kb.thread_messages` and `kb.threads`, and build access with `graph.grant_graph('space_threads', '<worker role>', 'build')`. Use a dedicated provider database for each workspace.
- Start `node --env-file=/absolute/path/to/worker.env thread-worker.mjs` with KNOWLEDGE_WORKSPACE_ID, THREAD_SOURCE_URL (Space ingestion login) and THREAD_INDEX_URL (index writer). Set THREAD_LOOKUP_URL (Space lookup login) on the provider, restart it and refresh discovery. The agent can use `filters: {"source":"threads"}`; omitting the source retains runbook search.
- Opt in a channel by inserting its workspace and channel UUIDs into Space's `knowledge_thread_channels`. Delete that pair to opt out. This pilot uses operator configuration; no channel is enabled by default.

The worker subscribes before backfilling and reconciles both databases on restart. It embeds up to 8,000 characters per human message, including replies. It excludes DMs, agent session messages, archived channels, and deleted or retained-away messages. Markdown attachments have a separate opt-in per channel. pgContext ranks messages; pgGraph connects messages to threads for related evidence. Each result links to the specific source message. Reads recheck the live revision, channel opt-in, requester and destination audience before returning text, even if the worker is behind.

This is a local pilot: recovery scans the opted-in corpus in pages, graph publication rebuilds the named graph, and a bounded candidate set can return fewer matches after access checks. For the database integration test run `node thread-smoke.mjs` with TEST_DATABASE_URL for a disposable Space test database (schema creation allowed), THREAD_INDEX_URL and KNOWLEDGE_DATABASE_URL for a test provider index, and local Ollama running.


For Markdown attachments, apply Space migration 084 and the provider's `markdown.sql`. Grant the worker SELECT on `knowledge_thread_files` and the provider lookup role EXECUTE on `knowledge_visible_files(uuid,uuid,uuid,uuid[])`. Set `index_markdown=true` on the intended `knowledge_thread_channels` row. It defaults to false. Restart the worker and provider and refresh tool discovery.

The worker splits sealed UTF-8 .md and .markdown files into passages. For legacy files and truncated previews, supply ASSET_STORAGE_ENDPOINT, ASSET_STORAGE_BUCKET, ASSET_STORAGE_ACCESS_KEY and ASSET_STORAGE_SECRET_KEY to the trusted worker with GetObject access to sealed originals. The provider only needs its Space lookup and index credentials. File search uses `filters.source=files` and returns permission-checked original download links. Switching the channel flag off removes files from search immediately and schedules index cleanup; messages keep their existing opt-in.

## Knowledge notes

Apply Space migration 088 and install `notes.sql` once in the provider database after `schema.sql`. Give the worker login membership in `space_note_collection` and SELECT/INSERT/UPDATE/DELETE on `kb.notes`. In Space, give the ingestion login SELECT on `knowledge_note_sources` and the provider lookup login EXECUTE on `knowledge_visible_notes(uuid,uuid,uuid,uuid[])`. Restart the worker and provider and refresh tool discovery.

The worker and provider detect `kb.notes` at startup; without it they behave as before. The worker copies notes from every channel with the Knowledge switch on, whatever its thread opt-in. It embeds the title and content, keeps only the highest revision, and removes notes that were removed, archived or switched off. Search uses `filters.source=notes`; each hit cites the note's first evidence message. Run `node notes-smoke.mjs` with the same three database URLs as `thread-smoke.mjs` to check indexing, live updates, removal while the worker is stopped, and restart recovery.
