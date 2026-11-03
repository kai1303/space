# AG-UI responses in Space

Approved scope: the conversation's AG-UI adapter → Space events → response renderer design, with streaming Markdown, tool activity, and registered result cards/tables. ACP is a separate future connector.

Use the official AG-UI HTTP client behind a server-configured connector. Map supported public events to existing execution events containing a validated accumulated response. Keep existing event sequence, receipt deduplication, approval, workspace authorization, and transactional chat delivery. Store completed response JSON alongside the message so paging and replay need no frontend reconstruction.

The renderer reuses Space's CodeBlock and ToolExecution. Markdown ignores HTML, restricts links, and does not fetch remote images. A CUSTOM event named `space.ui` upserts a validated card or table by ID. No agent-generated code executes and no tool advertised by the backend is executed by Space. Unsupported interrupts fail visibly; task-owner approval remains unchanged.

Bound event, text, tool, component, table and aggregate response sizes. Abort the backend request when the worker's existing deadline expires. A reconnecting/retried backend must replay a stable ordered event stream for the same execution/idempotency key; changed replays are rejected by existing receipts.

Validation covers malformed inputs, split text/tool arguments, completion versus tool argument completion, failed/truncated streams, replay, persisted structured messages, live channel/thread rendering, Markdown safety, and the existing task approval flow. Test with an actual loopback HTTP SSE backend, not production inference.
