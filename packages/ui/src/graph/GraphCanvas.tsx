import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import { arcPath, linkLabelAnchor, linkPath, NODE_RADIUS, type Point } from './layout.js';
import { GraphSimulation } from './simulation.js';

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
const MIN_SCALE = 0.2, MAX_SCALE = 4, VIEW_W = 800, VIEW_H = 600, RING_WIDTH = 22;
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
  const svg = useRef<SVGSVGElement>(null);
  const tooMany = nodes.length > MAX_GRAPH_NODES;

  const fit = (points: Map<string, Point>) => {
    const all = [...points.values()];
    if (!all.length) return { x: 0, y: 0, k: 1 };
    const pad = NODE_RADIUS + RING_WIDTH + 24;
    const minX = Math.min(...all.map(p => p.x)) - pad, maxX = Math.max(...all.map(p => p.x)) + pad;
    const minY = Math.min(...all.map(p => p.y)) - pad, maxY = Math.max(...all.map(p => p.y)) + pad;
    const k = clamp(Math.min(VIEW_W / (maxX - minX), VIEW_H / (maxY - minY), 1.4));
    return { x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k, k };
  };
  const simulation = useRef<GraphSimulation>(null as unknown as GraphSimulation);
  if (!simulation.current) simulation.current = new GraphSimulation(next => {
    setPositions(next);
    if (autoFit.current && simulation.current?.settled !== false) setView(fit(next));
  }, { reducedMotion: reducedMotion() });
  useEffect(() => () => simulation.current.stop(), []);

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
    const origin = id ? positions.get(id) ?? { x: 0, y: 0 } : { x: view.x, y: view.y };
    drag.current = { id, startX: event.clientX, startY: event.clientY, origin, moved: false };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = (event.clientX - d.startX) * scale(), dy = (event.clientY - d.startY) * scale();
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true; autoFit.current = false;
    if (d.id) simulation.current.drag(d.id, d.origin.x + dx / view.k, d.origin.y + dy / view.k);
    else setView(v => ({ ...v, x: d.origin.x + dx, y: d.origin.y + dy }));
  };
  const endDrag = () => { const d = drag.current; drag.current = null; if (d?.id && d.moved) simulation.current.release(); return d?.moved; };
  // Zoom keeps the scene point under the pointer still.
  const onWheel = (event: WheelEvent) => {
    autoFit.current = false;
    const rect = svg.current?.getBoundingClientRect();
    const px = rect?.width ? (event.clientX - rect.left) * (VIEW_W / rect.width) - VIEW_W / 2 : 0;
    const py = rect?.height ? (event.clientY - rect.top) * (VIEW_H / rect.height) - VIEW_H / 2 : 0;
    setView(v => { const k = clamp(v.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1)), f = k / v.k; return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f }; });
  };
  const zoomBy = (factor: number) => { autoFit.current = false; setView(v => { const k = clamp(v.k * factor), f = k / v.k; return { k, x: v.x * f, y: v.y * f }; }); };

  const selected = selectedId ? positions.get(selectedId) : undefined;
  const items = selectedId ? [...(menu?.(selectedId) ?? []), ...(selected?.pinned ? [{ label: 'Unpin', icon: '⌖', onClick: () => simulation.current.unpin(selectedId) }] : [])].slice(0, 4) : [];
  const inner = Math.max(NODE_RADIUS + 8, 20), segment = items.length ? (2 * Math.PI) / items.length : 0;

  return <div className="sp-graph">
    <div className="sp-graph-toolbar">
      <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
      <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
      <button type="button" aria-label="Fit graph" onClick={() => { autoFit.current = true; setView(fit(positions)); }}>⤢</button>
      <ul className="sp-graph-legend" aria-label="Legend">{Object.entries(palette).map(([kind, color]) =>
        <li key={kind}><span style={{ background: color }} />{kind}</li>)}</ul>
    </div>
    <div className="sp-graph-stage">
      <svg ref={svg} role="application" aria-label={label} className={`sp-graph-svg${hovered ? ' has-hover' : ''}`} viewBox={`${-VIEW_W / 2} ${-VIEW_H / 2} ${VIEW_W} ${VIEW_H}`}
        onWheel={onWheel} onPointerMove={moveDrag} onPointerUp={endDrag}>
        <defs><marker id="sp-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" /></marker></defs>
        <rect data-testid="sp-graph-background" x={-5000} y={-5000} width={10000} height={10000} className="sp-graph-background"
          onPointerDown={event => startDrag(event)} onClick={() => { if (!endDrag()) onSelect(undefined); }} onDoubleClick={() => simulation.current.unpin()} />
        <g data-testid="sp-graph-scene" transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {links.map(l => {
            const from = positions.get(l.source), to = positions.get(l.target);
            if (!from || !to) return null;
            const group = pairs.get(pairKey(l.source, l.target))!, index = group.indexOf(l.id);
            const anchor = linkLabelAnchor(from, to, index, group.length), width = l.label.length * 6 + 8;
            const faded = related && !(related.has(l.source) && related.has(l.target) && (l.source === hovered || l.target === hovered));
            return <g key={l.id} data-link-id={l.id} className={`sp-graph-link${faded ? ' is-faded' : ''}`}>
              <path d={linkPath(from, to, index, group.length)} markerEnd="url(#sp-graph-arrow)" />
              {/* The label sits in a gap cut out of the line, always upright. */}
              {view.k >= LABEL_MIN_SCALE && <g transform={`translate(${anchor.x},${anchor.y}) rotate(${anchor.angle})`}>
                <rect className="sp-graph-link-gap" x={-width / 2} y={-7} width={width} height={14} rx={3} />
                <text textAnchor="middle" dominantBaseline="central">{l.label}</text>
              </g>}
            </g>;
          })}
          {nodes.map(n => {
            const p = positions.get(n.id); if (!p) return null;
            const color = n.muted ? 'var(--sp-text-tertiary)' : palette[n.kind] ?? 'var(--sp-accent)';
            const lines = captionLines(n.caption);
            return <g key={n.id} data-node-id={n.id} role="button" tabIndex={0} aria-label={`${n.caption}, ${n.kind}${n.muted ? ', ended' : ''}`}
              aria-pressed={selectedId === n.id} aria-expanded={expandedIds.has(n.id)} transform={`translate(${p.x},${p.y})`}
              className={`sp-graph-node${selectedId === n.id ? ' is-selected' : ''}${n.muted ? ' is-muted' : ''}${related && !related.has(n.id) ? ' is-faded' : ''}${p.pinned ? ' is-pinned' : ''}`}
              onPointerEnter={() => setHovered(n.id)} onPointerLeave={() => setHovered(h => h === n.id ? undefined : h)}
              onPointerDown={event => { event.stopPropagation(); startDrag(event, n.id); }}
              onClick={event => { event.stopPropagation(); if (!endDrag()) onSelect(n.id); }}
              onDoubleClick={event => { event.stopPropagation(); onToggleExpand(n.id); }}
              onKeyDown={event => onNodeKey(event, n.id)}>
              {selectedId === n.id && <circle className="sp-graph-halo" r={NODE_RADIUS + 4} />}
              <circle className="sp-graph-dot" r={NODE_RADIUS} style={{ fill: `color-mix(in srgb, ${color} 88%, white)`, stroke: `color-mix(in srgb, ${color} 62%, black)` }} />
              <text className="sp-graph-caption" textAnchor="middle" dominantBaseline="central">
                {lines.map((line, i) => <tspan key={i} x={0} y={(i - (lines.length - 1) / 2) * 11}>{line}</tspan>)}
              </text>
            </g>;
          })}
          {/* Donut ring menu: equal slices around the selected node. */}
          {selected && items.length > 0 && <g role="menu" aria-label="Node actions" className="sp-graph-ring" transform={`translate(${selected.x},${selected.y})`}>
            {items.map((item, i) => {
              const start = -Math.PI / 2 - segment / 2 + i * segment, mid = start + segment / 2, r = inner + RING_WIDTH / 2;
              return <g key={item.label} role="menuitem" tabIndex={0} aria-label={item.label} className="sp-graph-ring-item"
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); item.onClick(); }}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.onClick(); } }}>
                <title>{item.label}</title>
                <path d={arcPath(inner, inner + RING_WIDTH, start, start + segment)} />
                <text x={Math.round(Math.cos(mid) * r * 10) / 10} y={Math.round(Math.sin(mid) * r * 10) / 10} textAnchor="middle" dominantBaseline="central">{item.icon ?? item.label.slice(0, 1)}</text>
              </g>;
            })}
          </g>}
        </g>
      </svg>
      {details && <aside className={`sp-graph-details${detailsOpen ? '' : ' is-collapsed'}`} aria-label="Details">
        <button type="button" className="sp-graph-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(open => !open)}>{detailsOpen ? 'Hide details' : 'Details'}</button>
        {detailsOpen && details}
      </aside>}
    </div>
    <ul className="sp-sr-only" aria-label={`${label} items`}>{nodes.map(n => <li key={n.id}>{n.caption} ({n.kind})</li>)}</ul>
  </div>;
}
