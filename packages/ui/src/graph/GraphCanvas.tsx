import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import { AnimatePresence, MotionConfig, animate, motion as m, useReducedMotion, type AnimationPlaybackControls } from 'motion/react';
import { surfaceMotion } from '../motion/motion.js';
import { arcPath, linkLabelAnchor, linkPath, NODE_RADIUS, type Point } from './layout.js';
import { GraphSimulation } from './simulation.js';
import { GraphIcon, isGraphIcon } from './icons.js';

export type GraphNode = { id: string; kind: string; caption: string; muted?: boolean };
export type GraphLink = { id: string; source: string; target: string; label: string };
export type GraphMenuItem = { label: string; icon?: string; onClick: () => void };
export type GraphCanvasProps = {
  nodes: GraphNode[]; links: GraphLink[];
  palette: Record<string, string>;
  selectedId?: string; expandedIds: ReadonlySet<string>;
  onSelect(id: string | undefined): void;
  onToggleExpand(id: string): void;
  menu?(id: string): GraphMenuItem[];
  details?: ReactNode;
  label: string;
};
export const MAX_GRAPH_NODES = 500;
// Zoom 0.1–2× like Neo4j; button and fit zooms ease over 400 ms, wheel zoom is immediate.
const MIN_SCALE = 0.1, MAX_SCALE = 2, VIEW_W = 800, VIEW_H = 600, RING_WIDTH = 30, FIT_PADDING = 0.05, ZOOM_MS = 400;
const clamp = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const reducedMotion = () => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Up to three short lines inside the circle; the full caption stays in the accessible name.
// Separator dots and dashes are dropped so they never take a line on their own.
export function captionLines(text: string, perLine = 10, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(w => w && !/^[·•\-–—|]$/.test(w));
  const lines: string[] = [];
  let line = '', used = 0;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= perLine) { line = next; used++; continue; }
    if (line) lines.push(line);
    if (lines.length === maxLines) { line = ''; break; }
    line = word; used++;
  }
  if (line) lines.push(line);
  const out = lines.map(l => l.length > perLine ? `${l.slice(0, perLine - 1)}…` : l);
  if (used < words.length && out.length) {
    const last = out.length - 1;
    if (!out[last]!.endsWith('…')) out[last] = `${out[last]!.slice(0, perLine - 1)}…`;
  }
  return out;
}
// Below this zoom, link labels are unreadable clutter, so only the lines are drawn.
export const LABEL_MIN_SCALE = 0.75;

export function GraphCanvas({ nodes, links, palette, selectedId, expandedIds, onSelect, onToggleExpand, menu, details, label }: GraphCanvasProps) {
  const [positions, setPositions] = useState(new Map<string, Point>());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hovered, setHovered] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(true);
  const autoFit = useRef(true);
  const drag = useRef<{ id?: string; startX: number; startY: number; origin: Point; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const svg = useRef<SVGSVGElement>(null);
  const tooMany = nodes.length > MAX_GRAPH_NODES;

  const fit = (points: Map<string, Point>) => {
    const all = [...points.values()];
    if (!all.length) return { x: 0, y: 0, k: 1 };
    const pad = NODE_RADIUS + 12;
    const minX = Math.min(...all.map(p => p.x)) - pad, maxX = Math.max(...all.map(p => p.x)) + pad;
    const minY = Math.min(...all.map(p => p.y)) - pad, maxY = Math.max(...all.map(p => p.y)) + pad;
    const k = clamp(Math.min(VIEW_W * (1 - 2 * FIT_PADDING) / (maxX - minX), VIEW_H * (1 - 2 * FIT_PADDING) / (maxY - minY), MAX_SCALE));
    return { x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k, k };
  };
  const prefersReduced = useReducedMotion();
  const motionState = useRef({ reduced: reducedMotion(), zoom: undefined as AnimationPlaybackControls | undefined });
  const reduced = motionState.current.reduced || !!prefersReduced;
  const viewRef = useRef(view); viewRef.current = view;
  // Ease the view to a target with motion.dev (immediately with reduced motion).
  const animateView = (target: { x: number; y: number; k: number }) => {
    motionState.current.zoom?.stop();
    if (motionState.current.reduced) { setView(target); return; }
    const from = viewRef.current;
    motionState.current.zoom = animate(0, 1, {
      duration: ZOOM_MS / 1000, ease: [0.2, 0, 0, 1],
      onUpdate: t => setView({ x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t, k: from.k + (target.k - from.k) * t }),
    });
  };
  const wasSettled = useRef(false);
  const simulation = useRef<GraphSimulation>(null as unknown as GraphSimulation);
  if (!simulation.current) simulation.current = new GraphSimulation(next => {
    setPositions(next);
    // Like Neo4j, fit once the layout comes to rest (not on every frame), until the user takes over.
    const settled = simulation.current?.settled !== false;
    if (autoFit.current && settled && !wasSettled.current) animateView(fit(next));
    else if (autoFit.current && settled && motionState.current.reduced) setView(fit(next));
    wasSettled.current = settled;
  }, { reducedMotion: motionState.current.reduced });
  useEffect(() => () => { simulation.current.stop(); motionState.current.zoom?.stop(); }, []);
  // Nodes and links in the first laid-out picture appear in place; anything added later animates in.
  const firstPicture = useRef<{ nodes: Set<string>; links: Set<string> }>(undefined);
  if (!firstPicture.current && positions.size) firstPicture.current = { nodes: new Set(positions.keys()), links: new Set(links.map(l => l.id)) };
  const enters = (kind: 'nodes' | 'links', id: string) => !!firstPicture.current && !firstPicture.current[kind].has(id);
  const spring = reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 420, damping: 26 };
  const fade = { duration: reduced ? 0 : 0.18, ease: [0.2, 0, 0, 1] as const };

  // Re-run the layout only when the set of nodes or links changes, not on caption updates.
  const shape = useMemo(() => `${nodes.map(n => n.id).join(',')}|${links.map(l => `${l.source}>${l.target}`).join(',')}`, [nodes, links]);
  useLayoutEffect(() => { if (!tooMany) simulation.current.update(nodes, links); }, [shape, tooMany]);

  const neighbours = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const l of links) { map.set(l.source, [...(map.get(l.source) ?? []), l.target]); map.set(l.target, [...(map.get(l.target) ?? []), l.source]); }
    return map;
  }, [links]);
  const pairs = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const l of links) { const k = pairKey(l.source, l.target); groups.set(k, [...(groups.get(k) ?? []), l.id]); }
    return groups;
  }, [links]);

  if (tooMany) return <p role="status" className="sp-graph-status">Too many items to draw ({nodes.length}). Hide some threads first.</p>;

  const related = hovered ? new Set([hovered, ...(neighbours.get(hovered) ?? [])]) : undefined;
  const scale = () => { const width = svg.current?.clientWidth; return width ? VIEW_W / width : 1; };
  const focusNode = (id: string) => [...(svg.current?.querySelectorAll<SVGGElement>('[data-node-id]') ?? [])].find(el => el.dataset.nodeId === id)?.focus();
  const onNodeKey = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter') { event.preventDefault(); onToggleExpand(id); }
    else if (event.key === ' ') { event.preventDefault(); onSelect(id); }
    else if (event.key.startsWith('Arrow')) {
      const list = neighbours.get(id) ?? [];
      if (!list.length) return;
      event.preventDefault();
      focusNode(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? list.at(-1)! : list[0]!);
    }
  };
  const startDrag = (event: PointerEvent, id?: string) => {
    swallowClick.current = false;
    const origin = id ? positions.get(id) ?? { x: 0, y: 0 } : { x: view.x, y: view.y };
    drag.current = { id, startX: event.clientX, startY: event.clientY, origin, moved: false };
    if (id) simulation.current.dragStart(id, event.clientX, event.clientY);
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = (event.clientX - d.startX) * scale(), dy = (event.clientY - d.startY) * scale();
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true; autoFit.current = false;
    if (d.id) simulation.current.drag(d.id, d.origin.x + dx / view.k, d.origin.y + dy / view.k, event.clientX, event.clientY);
    else setView(v => ({ ...v, x: d.origin.x + dx, y: d.origin.y + dy }));
  };
  // pointerup ends a drag before the browser fires its click, so remember that the gesture was a
  // drag and swallow the click that follows: a drag-and-drop never selects, pins or deselects.
  const endDrag = () => {
    const d = drag.current; drag.current = null;
    if (d?.moved) { swallowClick.current = true; if (d.id) simulation.current.release(); }
    return d?.moved;
  };
  const wasDrag = () => { endDrag(); const dragged = swallowClick.current; swallowClick.current = false; return dragged; };
  // Zoom keeps the scene point under the pointer still.
  const onWheel = (event: WheelEvent) => {
    autoFit.current = false;
    const rect = svg.current?.getBoundingClientRect();
    const px = rect?.width ? (event.clientX - rect.left) * (VIEW_W / rect.width) - VIEW_W / 2 : 0;
    const py = rect?.height ? (event.clientY - rect.top) * (VIEW_H / rect.height) - VIEW_H / 2 : 0;
    setView(v => { const k = clamp(v.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1)), f = k / v.k; return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f }; });
  };
  const zoomBy = (factor: number) => { autoFit.current = false; const v = viewRef.current, k = clamp(v.k * factor), f = k / v.k; animateView({ k, x: v.x * f, y: v.y * f }); };

  const selected = selectedId ? positions.get(selectedId) : undefined;
  const items = selectedId ? [...(menu?.(selectedId) ?? []), ...(selected?.pinned ? [{ label: 'Unpin', icon: 'unpin', onClick: () => { simulation.current.unpin(selectedId); onSelect(undefined); } }] : [])].slice(0, 4) : [];
  const inner = Math.max(NODE_RADIUS + 8, 20), segment = items.length ? (2 * Math.PI) / items.length : 0;

  const press = reduced ? {} : { whileTap: { scale: 0.9 }, transition: fade };
  return <MotionConfig reducedMotion="user"><div className="sp-graph">
    <div className="sp-graph-toolbar">
      <m.button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)} {...press}>+</m.button>
      <m.button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)} {...press}>−</m.button>
      <m.button type="button" aria-label="Fit graph" onClick={() => { autoFit.current = true; animateView(fit(positions)); }} {...press}>⤢</m.button>
      <ul className="sp-graph-legend" aria-label="Legend">{Object.entries(palette).map(([kind, color]) =>
        <li key={kind}><span style={{ background: color }} />{kind}</li>)}</ul>
    </div>
    <div className="sp-graph-stage">
      <svg ref={svg} role="application" aria-label={label} className={`sp-graph-svg${hovered ? ' has-hover' : ''}`} viewBox={`${-VIEW_W / 2} ${-VIEW_H / 2} ${VIEW_W} ${VIEW_H}`}
        onWheel={onWheel} onPointerMove={moveDrag} onPointerUp={endDrag}>
        <defs><marker id="sp-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" /></marker></defs>
        <rect data-testid="sp-graph-background" x={-5000} y={-5000} width={10000} height={10000} className="sp-graph-background"
          onPointerDown={event => startDrag(event)} onClick={() => { if (!wasDrag()) onSelect(undefined); }} onDoubleClick={() => simulation.current.unpin()} />
        <g data-testid="sp-graph-scene" transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* Links draw themselves in when added and fade out when removed. */}
          <AnimatePresence initial={false}>{links.map(l => {
            const from = positions.get(l.source), to = positions.get(l.target);
            if (!from || !to) return null;
            const group = pairs.get(pairKey(l.source, l.target))!, index = group.indexOf(l.id);
            const anchor = linkLabelAnchor(from, to, index, group.length), width = l.label.length * 6 + 8;
            const faded = related && !(related.has(l.source) && related.has(l.target) && (l.source === hovered || l.target === hovered));
            return <m.g key={l.id} data-link-id={l.id} className={`sp-graph-link${faded ? ' is-faded' : ''}`}
              initial={enters('links', l.id) ? { opacity: 0 } : false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
              <m.path d={linkPath(from, to, index, group.length)} markerEnd="url(#sp-graph-arrow)"
                initial={enters('links', l.id) ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={reduced ? { duration: 0 } : { duration: 0.35, ease: [0.2, 0, 0, 1] }} />
              {/* The label sits in a gap cut out of the line, always upright. */}
              <AnimatePresence initial={false}>{view.k >= LABEL_MIN_SCALE && <m.g key="label" transform={`translate(${anchor.x},${anchor.y}) rotate(${anchor.angle})`}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                <rect className="sp-graph-link-gap" x={-width / 2} y={-7} width={width} height={14} rx={3} />
                <text textAnchor="middle" dominantBaseline="central">{l.label}</text>
              </m.g>}</AnimatePresence>
            </m.g>;
          })}</AnimatePresence>
          {/* Nodes pop in with a spring when added and shrink away when removed. */}
          <AnimatePresence initial={false}>{nodes.map(n => {
            const p = positions.get(n.id); if (!p) return null;
            const color = n.muted ? 'var(--sp-text-tertiary)' : palette[n.kind] ?? 'var(--sp-accent)';
            const lines = captionLines(n.caption);
            return <m.g key={n.id} exit={{ opacity: 0 }} transition={fade}><g data-node-id={n.id} role="button" tabIndex={0} aria-label={`${n.caption}, ${n.kind}${n.muted ? ', ended' : ''}`}
              aria-pressed={selectedId === n.id} aria-expanded={expandedIds.has(n.id)} transform={`translate(${p.x},${p.y})`}
              className={`sp-graph-node${selectedId === n.id ? ' is-selected' : ''}${n.muted ? ' is-muted' : ''}${related && !related.has(n.id) ? ' is-faded' : ''}${p.pinned ? ' is-pinned' : ''}`}
              onPointerEnter={() => { setHovered(n.id); simulation.current.hold(n.id); }}
              onPointerLeave={() => { setHovered(h => h === n.id ? undefined : h); simulation.current.letGo(n.id); }}
              onPointerDown={event => { event.stopPropagation(); startDrag(event, n.id); }}
              // Like Neo4j: a click fixes the node in place and toggles its selection.
              onClick={event => { event.stopPropagation(); if (wasDrag()) return; simulation.current.pin(n.id); onSelect(selectedId === n.id ? undefined : n.id); }}
              onDoubleClick={event => { event.stopPropagation(); onToggleExpand(n.id); }}
              onKeyDown={event => onNodeKey(event, n.id)}>
              <m.g initial={enters('nodes', n.id) ? { scale: 0, opacity: 0 } : false} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4 }} transition={spring}>
                {/* The halo grows out from the node edge on select and hover. */}
                <AnimatePresence>{(selectedId === n.id || hovered === n.id) && <m.circle key={selectedId === n.id ? 'selected' : 'hover'}
                  className={`sp-graph-halo${selectedId === n.id ? '' : ' is-hover'}`}
                  initial={{ r: NODE_RADIUS, opacity: 0 }} animate={{ r: NODE_RADIUS + 4, opacity: 1 }} exit={{ r: NODE_RADIUS, opacity: 0 }} transition={spring} />}</AnimatePresence>
                <circle className="sp-graph-dot" r={NODE_RADIUS} style={{ fill: `color-mix(in srgb, ${color} 88%, white)`, stroke: `color-mix(in srgb, ${color} 62%, black)` }} />
                <text className="sp-graph-caption" textAnchor="middle" dominantBaseline="central">
                  {lines.map((line, i) => <tspan key={i} x={0} y={(i - (lines.length - 1) / 2) * 11}>{line}</tspan>)}
                </text>
              </m.g>
            </g></m.g>;
          })}</AnimatePresence>
          {/* Donut ring menu: equal slices around the selected node, the first starting at 12 o'clock. */}
          {/* The ring blooms out from the node; slices fade in one after another. */}
          <AnimatePresence>{selected && items.length > 0 && <g key={selectedId} transform={`translate(${selected.x},${selected.y})`}>
            <m.g role="menu" aria-label="Node actions" className="sp-graph-ring"
              initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} transition={spring}>
              {items.map((item, i) => {
                const start = -Math.PI / 2 + i * segment, mid = start + segment / 2, r = inner + RING_WIDTH / 2;
                const ix = Math.round(Math.cos(mid) * r * 10) / 10, iy = Math.round(Math.sin(mid) * r * 10) / 10;
                return <m.g key={item.label} role="menuitem" tabIndex={0} aria-label={item.label} className="sp-graph-ring-item"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...fade, delay: reduced ? 0 : i * 0.04 }}
                  onPointerDown={event => event.stopPropagation()}
                  onClick={event => { event.stopPropagation(); item.onClick(); }}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.onClick(); } }}>
                  <title>{item.label}</title>
                  <path className="sp-graph-ring-slice" d={arcPath(inner, inner + RING_WIDTH, start, start + segment)} />
                  {isGraphIcon(item.icon) ? <GraphIcon name={item.icon} x={ix} y={iy} />
                    : <text x={ix} y={iy} textAnchor="middle" dominantBaseline="central">{item.icon ?? item.label.slice(0, 1)}</text>}
                </m.g>;
              })}
            </m.g>
          </g>}</AnimatePresence>
        </g>
      </svg>
      {/* The details panel slides in from the right and resizes smoothly when collapsed. */}
      <AnimatePresence>{details && <m.aside key="details" className={`sp-graph-details${detailsOpen ? '' : ' is-collapsed'}`} aria-label="Details"
        layout={!reduced} {...surfaceMotion(reduced, 'right')}>
        <button type="button" className="sp-graph-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(open => !open)}>{detailsOpen ? 'Hide details' : 'Details'}</button>
        <AnimatePresence initial={false} mode="popLayout">{detailsOpen && <m.div key="body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>{details}</m.div>}</AnimatePresence>
      </m.aside>}</AnimatePresence>
    </div>
    <ul className="sp-sr-only" aria-label={`${label} items`}>{nodes.map(n => <li key={n.id}>{n.caption} ({n.kind})</li>)}</ul>
  </div></MotionConfig>;
}
