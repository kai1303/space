# Every tool card — scoped design QA

final result: passed

## Reference and scope

Source: the user’s annotated Plyxl screenshot, https://plyxl.com/ (`#agent`, first capability card). Source HTML and illustration geometry inspected in `/tmp/plyxl-reference.html`.

Implementation: `http://127.0.0.1:5173/#agents`.
Screenshots: `/tmp/space-every-tool-desktop.png` and `/tmp/space-every-tool-mobile.png`.

The source attachment is 1278 × 1280 pixels for an approximately 852 × 853 CSS-pixel viewport (1.5× density). The implementation captures use 852 × 853 and 390 × 853 CSS pixels at 1×. Comparison accounts for the source density. The selected first card is the scope; surrounding Space cards and page gutters intentionally retain their existing layout.

## Findings

No actionable P0/P1/P2 findings in the selected card.

- Typography: existing Geist font; reference title size 15.5px/500, body 14.5px/1.5, caption 9 SVG units.
- Layout: original 220 × 136 SVG geometry, 240px maximum illustration width, original tile positions, circle radius, rounded corners, and 20px illustration-to-copy spacing. Existing parent grid controls overall card width and row height.
- Colors: source paper, illustration background, muted text, faint caption, violet connectors, and green board tile copied from the source tokens.
- Assets: Gmail, QuickBooks, Slack, and Stripe assets retained; board glyph extracted from the reference icon sprite. Only the central brand mark is replaced with Space.
- Copy: “Every tool”, its description, and “+ any MCP server or API” match the selected reference.
- Motion: five connector paths animate with Motion; viewport visibility and reduced-motion preference govern playback.

## Verification

The in-app browser rendered the changed card at tablet and phone widths. The phone illustration remains centered, text wraps without clipping, and document width equals viewport width (390px). Five connection paths are present. No browser console errors were recorded. The web TypeScript/Vite build passed.

The screenshot and source inspection cover this visual-only card. No interactive controls were introduced. No unrelated capability cards were rewritten.
