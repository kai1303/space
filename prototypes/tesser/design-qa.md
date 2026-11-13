# Tesser homepage replica

The reference was the public homepage at [tesser.sh](https://tesser.sh/), captured on November 13, 2026. Run `npm run dev` here to serve the captured homepage at http://127.0.0.1:5194/.

## Visual comparison

Source and local pages ran in separate Chrome contexts at the same dimensions with reduced motion enabled. The comparison used decoded RGBA pixels. The live page and the preview matched on text, 56 measured element boxes, typefaces, font sizes, colors, and normalized link destinations at both widths.

| Capture | Different pixels | Total pixels |
| --- | ---: | ---: |
| Desktop viewport, 1440 × 900 | 0 | 1,296,000 |
| Desktop full page, 1440 × 4913 | 0 | 7,074,720 |
| Mobile viewport, 390 × 844 | 0 | 329,160 |
| Mobile full page, 390 × 7944 | 120 | 3,098,160 |

The mobile difference occupies one 8 × 15 px rectangle at x=68, y=3331. Animation phase across arbitrary frames and other browsers is unverified.

## Behavior

Both install-command buttons and both agent-prompt buttons copied text. The four setup controls and six FAQ disclosures responded on desktop and mobile. Account, documentation, and other off-homepage links lead to their original destinations. Analytics are disabled. The local homepage made zero external HTTP requests and produced zero browser exceptions or failed HTTP requests in the final check.

Final result: passed for the local homepage visual reference, with the mobile pixel difference recorded above.
