# How Plyxl’s homepage works

Inspected the public homepage on November 5, 2026. The evidence is the server-rendered HTML, the shipped client bundle and stylesheets, and Chrome captures at 1440 × 900 and 390 × 844. Intermediate widths were checked for the agent wall. This describes the public landing page, including its simulated product UI. [Homepage](https://plyxl.com/) · [Homepage JavaScript](https://plyxl.com/_next/static/chunks/1c08069534f46176.js) · [Base CSS](https://plyxl.com/_next/static/chunks/2c7aced4abe1de3a.css) · [Page CSS](https://plyxl.com/_next/static/chunks/220f5e0c143f83f2.css)

## Page structure

The fixed header sits above eight direct sections in `main`, followed by a footer. The navbar turns from transparent to a blurred light surface once the window has scrolled past 8px. The body of the page uses a near-white lavender background (#FCFBFF), dark ink (#181630), and fine dividers. The browser resolves the heading font to Geist even though the utility class is named `font-serif-display`. The cloud-and-sheep artwork and workspace window carry most of the color above the fold. [Homepage](https://plyxl.com/) · [Client bundle](https://plyxl.com/_next/static/chunks/1c08069534f46176.js)

| Section in DOM order | Desktop composition | Phone composition |
| --- | --- | --- |
| 1. Hero and workspace, `#top` | Centered headline, supporting copy, YC mark and two actions against the illustrated sky. The scene opens onto a captioned workspace demo with a scripted cursor. | Headline wraps at about 44.5px. The workspace switches to a portrait stage with its own cursor positions and framing. |
| 2. Agent, `#agent` | Left-aligned headline, three moving columns, then five illustrated capability panels in a ruled row. | One moving column, then all five capability panels stacked. This makes the section substantially taller even though the moving window is shorter. |
| 3. Connections, `#connections` | Headline on the left, compact sign-in demo at the right, three full-width rows of logos underneath. The tracks extend past the text margins. | Status card stacks below the heading. All three rows remain, with smaller tiles and gaps. |
| 4. Custom apps, `#apps` | Heading and short explanation, four request-to-result examples in a two-column grid, then a three-step walkthrough. | The examples become a horizontally scrollable, snapping strip. A card uses 86% of the available width, leaving part of the next one visible. |
| 5. App store, `#store` | Intro at left. Nine catalog entries form a three-column ruled grid on the right. Each has an icon, name and one-line purpose. | Intro above a two-column catalog. |
| 6. Guided setup, `#pricing` | A large split panel pairs the founder-led setup offer and its three steps with an illustrated appointment picker. The picker illustration is a single booking link. | Copy and booking illustration stack inside the panel. |
| 7. FAQ, `#faq` | Sticky intro and contact at the left, nine accordion items at the right. The first starts open. Opening the second closed the first in Chrome. | Intro precedes the same accordion. |
| 8. Closing prompt, unnamed section | Mascot, headline, an animated example prompt and two action links. The apparent input and send arrow are presentational spans. | Same sequence centered in one column, followed by the footer. |

## Motion and construction

### Hero walkthrough

The headline reveals individual words through clipped spans, with 100ms between starts. The workspace frame enters over 1 second after a 600ms delay. Inside it, the site renders a scaled HTML scene with scripted cursor positions and timed captions. The stage is 1200 × 660 on desktop and 440 × 680 on narrow screens. The four chapters cover asking for an app (5.7s), building it from workspace data (7.9s), using it with connected tools (11s), and giving the agent a task (17.2s). The clock advances with animation frames while the demo is in view. Leaving the page at the same scroll position advanced the caption and the workspace UI. [Client bundle](https://plyxl.com/_next/static/chunks/1c08069534f46176.js) · [Page CSS](https://plyxl.com/_next/static/chunks/220f5e0c143f83f2.css)

### Agent wall

The bundle distributes 15 examples into three fixed sets by index modulo three. Each column starts with five server-rendered figures. On mount, the client appends five accessibility-hidden duplicates. The column translates by half its total height in a linear, infinite CSS loop. Directions are up, down, up and durations are 64s, 76s, 70s. A gradient mask fades the outer 12% at each vertical edge. The visible examples on a phone come from the first set of five. [Client bundle](https://plyxl.com/_next/static/chunks/1c08069534f46176.js) · [Marquee keyframes and masks](https://plyxl.com/_next/static/chunks/2c7aced4abe1de3a.css)

| Browser width | Visible columns | Card width | Clipped wall height |
| ---: | ---: | ---: | ---: |
| 390px | 1 | 350px | 540px |
| 640px | 1 | 576px | 600px |
| 768px | 2 | 344px | 600px |
| 1024px | 3 | about 309px | 600px |
| 1440px | 3 | 368px | 600px |

Each figure has 20px padding, 20px corners and a faint outline. A 28px initial avatar, name and muted role sit on one line. The request is set at 16.5px with a colored mention. A divider introduces a single compact result row with a 26px agent icon, 13.5px outcome and small overlapping tool logos. The illustrative strip below the wall separately explains tool access, approvals, scheduled work, memory and notifications. [Agent markup and styles](https://plyxl.com/_next/static/chunks/1c08069534f46176.js)

### Connections

The demo card has a maximum width of 400px. A local timer changes the displayed provider from signing in to connected after 1.3s, then advances to the next provider at 3.2s. Five examples cycle. Chrome showed the QuickBooks status changing at a fixed scroll position on both screen sizes. This is a scripted account and capability display. [Connection demo implementation](https://plyxl.com/_next/static/chunks/1c08069534f46176.js)

The three rows contain 16, 15 and 15 original logos. Each tile is a white rounded square containing only a brand mark. Desktop tiles are 60px with a 36px mark and 16px gaps. Phone tiles are 52px with a 30px mark and 12px gaps. After hydration, each row has four copies of its original sequence. The three extra copies are hidden from assistive technology. The rows translate by half their total width over 120s left, 140s right and 130s left. An edge mask fades the outer 14% on each side. [Connection track markup](https://plyxl.com/_next/static/chunks/1c08069534f46176.js) · [Horizontal keyframes and masks](https://plyxl.com/_next/static/chunks/2c7aced4abe1de3a.css)

### Scroll and reduced motion

The common entrance uses IntersectionObserver with a 0.12 threshold, an 8% inset at the viewport bottom, and a one-time reveal. It sets `data-shown` to transition opacity and a 20px vertical offset over 800ms. Once visible, the card and logo tracks advance with elapsed time, independently of scroll distance. Under reduced motion, Chrome computed a single 0.01ms iteration on all six tracks. The workspace demo also checks the media preference when choosing its clock behavior. [Reveal and demo code](https://plyxl.com/_next/static/chunks/1c08069534f46176.js) · [Motion rules](https://plyxl.com/_next/static/chunks/2c7aced4abe1de3a.css)

The focused REA static analysis of the homepage bundle produced evidence ID `ev_596d8a441a3191b083d2fff0c41ee210fddb7593783015c50e8ff53be86c4757`. Browser measurements above were taken separately against the live page.
