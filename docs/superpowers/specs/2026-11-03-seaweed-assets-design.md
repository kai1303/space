# SeaweedFS chat attachments

Approved direction: self-hosted SeaweedFS, a private bucket, PostgreSQL asset metadata, and direct signed browser uploads. No AWS account is required.

Each channel member may create an upload for a file of 1–26,214,400 bytes. Messages accept up to five unique asset IDs, including attachment-only messages. Assets are owned by the uploader, belong to one channel, and can be attached once. Current channel/organization/workspace authorization is checked at create, completion, send and download. Retry IDs include asset IDs. Existing messages retain their original retry hash when no assets are provided.

The browser receives a five-minute signed POST policy enforcing the exact generated staging key and file size. Completion verifies and copies the staging object to a server-only final key, protecting finalized content from reuse of a signed upload. All files download with attachment disposition and octet-stream content type. No inline HTML/SVG rendering. Unattached assets expire after 24 hours; periodic cleanup removes their objects and staging objects after upload credentials expire. Cleanup is bounded and safe across API processes using database locks.

SeaweedFS is pinned in Compose with persistent data, credentials, private networking for internal components, a browser-reachable gateway, bucket bootstrap, and CORS restricted to configured app origins. Internal and browser storage endpoints may differ. Storage can be disabled when configuration is absent; the chat composer reports availability.

Verification includes contract bounds, actual PostgreSQL authorization/idempotency/history/realtime behavior, actual SeaweedFS signed POST/copy/download/cleanup behavior, UI upload success/failure/retry, typecheck and build. No deployment, public bucket, rich asset preview, multipart upload, or virus-scanning service is included.
