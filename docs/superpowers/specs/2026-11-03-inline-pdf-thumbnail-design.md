# Inline PDF thumbnails

The user asked to fix channel file rendering after the comparison identified
icon-only PDF cards. Add a clickable first-page preview to message attachments,
retain the shared full viewer, and make filenames open that viewer with a separate
download control. Images retain bounded derivatives and gain natural image sizing.

Generate a PDF thumbnail only when its authenticated thumbnail endpoint is first
requested. Store one WebP under the existing preview key and persist a boolean
thumbnail result in PDF preview JSON. The existing row lock deduplicates requests
across API instances. Cache malformed/encrypted/over-budget failures; leave storage
outages, missing renderer and capacity exhaustion retryable. No schema migration.

Use Poppler's first-page-only renderer in a short-lived process, two jobs per API,
8s wall timeout, max 720px output, then Sharp to at most 360x240 WebP. Linux runtime
also enforces 512MiB address space, 5 CPU seconds and 4MiB output-file limits using
prlimit. Docker includes poppler-utils, util-linux-misc and Liberation fonts. Delete temporary files.
Keep the 25MiB input limit, cheap prefix-only PDF classification and authenticated
range transport for the full viewer. Browser cards lazy-load the thumbnail only.

Alternatives considered: rendering every PDF in browser repeats transfer/CPU per
viewer; rendering during upload spends work on unseen files. On-demand persisted
thumbnails meet the existing cost intent with no conversion service or queue.

Validation covers real first-page conversion, invalid input, concurrency, storage
failures, authorization and persisted success/failure, UI error fallback, lazy image
loading, keyboard preview/download separation, build and browser rendering.
Slack's exact populated-card appearance remains unverified; this fixes the known
functional and presentation gap without claiming pixel parity.
