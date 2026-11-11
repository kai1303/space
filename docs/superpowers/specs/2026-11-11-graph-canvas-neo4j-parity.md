# GraphCanvas: Neo4j Browser behavior parity

## Goal

Make `@space/ui/graph` `GraphCanvas` behave like the Neo4j Browser graph view. Behavior and visual facts were studied from the public Neo4j Browser repository (GPL-3.0). **No Neo4j code is copied or translated.** Space stays MIT: we reimplement the observed behavior from the facts below, in our own structure, using `d3-force` (ISC) and React.

## Observed behavior (facts) and our target

| Area | Neo4j Browser (observed) | Space target |
| --- | --- | --- |
| Simulation | `d3-force` runs live: charge, link, collide, weak centre `forceX`/`forceY`. Velocity decay 0.4, stops below alpha 0.05, up to 300 ticks pre-computed, then extra ticks per frame | Same forces and constants. Pre-compute up to 300 ticks, then animate the rest with `requestAnimationFrame` until alpha < 0.05, then stop. No timer while idle |
| New nodes | Placed on a circle, then settle | New nodes start next to their parent and spring out (simulation reheated to alpha 0.3) |
| Drag | Dragging pins the node (`fx`/`fy`) and raises the alpha target, so neighbours follow. Release keeps it pinned | Same. Drag sets alpha target 0.09 while held, 0 on release. Node stays pinned |
| Unpin | Ring menu "Unlock" clears the pin | Same, plus double-click on empty space clears all pins |
| Caption | Text inside the circle, cut to fit | Caption inside the circle, up to 2 lines, cut with an ellipsis. Text colour picked for contrast |
| Node style | Light fill per label with a darker border. Size by label style, default radius 25 | Pastel fill from `palette`, border 2 px of a darker shade (`color-mix`). Radius 25 |
| Relationship | Straight line with an arrowhead. The label sits at the midpoint, upright, and the line is broken around it. Parallel links curve apart | Same. The label gap uses a measured text width (or 6.5 px per character). Labels never render upside down |
| Selection | Click selects. Selected nodes get a halo ring | Same, with a halo ring of `--sp-focus` |
| Hover | Hover highlights the node and its links | Hovered node and its links are fully opaque. Others fade to 0.35 |
| Ring menu | A donut around the selected node: 3 equal arc segments, inner radius = node radius + 8 (min 20), fixed width, pad angle 0.03 rad. Items: Remove (dismiss), Expand/Collapse, Unlock. Icon per segment, with a tooltip | Same layout as SVG `<path>` arcs from our own arc math. Items come from `menu(id)` (up to 4). Each arc is `role="menuitem"` with `aria-label` and a `<title>` tooltip |
| Zoom | Wheel zoom around the pointer, buttons for zoom in/out/fit | Wheel zoom keeps the point under the pointer still. Fit centres all nodes |
| Details | Inspector panel inside the visualisation: hovered or selected item, label chips, property table | `GraphCanvas` gets an optional `details` render prop shown in a collapsible corner panel. `MemoryInspector` moves into it |
| Reduced motion | — | Skip animation: settle synchronously, as today |

## Acceptance tests

1. Live layout: after a node is added, frames are requested until alpha < 0.05, then none (fake `requestAnimationFrame`).
2. Drag: during drag a neighbour's position changes. After release the dragged node keeps `fx`/`fy`.
3. Ring menu: a selected node renders N arc segments with equal angles and inner radius = r + 8. Clicking a segment runs its action. Unlock clears the pin.
4. Caption sits inside the circle (text centred on the node, no `y` offset below it).
5. Link label is upright and centred, and the visible line has a gap at the label.
6. Hover fades unrelated nodes and links.
7. Wheel zoom: the scene point under the pointer stays fixed.
8. Reduced motion: no frames are requested, and positions are final at first paint.
9. Existing tests still pass: accessible names, keyboard, 500-node limit.

## Out of scope

Styling editor, Cypher, label legend editing, saved layouts.
