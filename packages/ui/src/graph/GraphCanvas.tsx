import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { layoutGraph, linkPath, NODE_RADIUS, type Point } from './layout.js';

export type GraphNode = { id: string; kind: string; caption: string; muted?: boolean };
export type GraphLink = { id: string; source: string; target: string; label: string };
export type GraphMenuItem = { label: string; onClick: () => void };
export type GraphCanvasProps = {
  nodes: GraphNode[]; links: GraphLink[];
  palette: Record<string, string>;
  selectedId?: string; expandedIds: ReadonlySet<string>;
  onSelect(id: string | undefined): void;
  onToggleExpand(id: string): void;
  menu?(id: string): GraphMenuItem[];
  label: string;
};
export const MAX_GRAPH_NODES = 500;
const MIN_SCALE = 0.2, MAX_SCALE = 4, VIEW_W = 800, VIEW_H = 600;
const cut = (text: string) => text.length > 24 ? `${text.slice(0, 24).trimEnd()}…` : text;
const clamp = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function GraphCanvas({ nodes, links, palette, selectedId, expandedIds, onSelect, onToggleExpand, menu, label }: GraphCanvasProps) {
  const positions = useRef(new Map<string, Point>());
  const [pins, setPins] = useState(new Map<string, Point>());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ id?: string; startX: number; startY: number; origin: Point; moved: boolean } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tooMany = nodes.length > MAX_GRAPH_NODES;

  // Layout runs synchronously before paint; earlier positions are reused so the picture stays stable.
  const layout = useMemo(() => {
    if (tooMany) return new Map<string, Point>();
    const next = layoutGraph(nodes, links, new Map([...positions.current, ...pins]));
    positions.current = next;
    return next;
  }, [nodes, links, pins, tooMany]);
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
    const origin = id ? layout.get(id)! : { x: view.x, y: view.y };
    drag.current = { id, startX: event.clientX, startY: event.clientY, origin, moved: false };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = event.clientX - d.startX, dy = event.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (d.id) { const id = d.id; setPins(old => new Map(old).set(id, { x: d.origin.x + dx / view.k, y: d.origin.y + dy / view.k, pinned: true })); }
    else setView(v => ({ ...v, x: d.origin.x + dx, y: d.origin.y + dy }));
  };
  const endDrag = () => { const moved = drag.current?.moved; drag.current = null; return moved; };
  const onWheel = (event: WheelEvent) => { setView(v => ({ ...v, k: clamp(v.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1)) })); };
  const selected = selectedId ? layout.get(selectedId) : undefined;
  const items = selectedId && menu ? menu(selectedId) : [];

  return <div className="sp-graph">
    <div className="sp-graph-toolbar">
      <button type="button" aria-label="Zoom in" onClick={() => setView(v => ({ ...v, k: clamp(v.k * 1.25) }))}>+</button>
      <button type="button" aria-label="Zoom out" onClick={() => setView(v => ({ ...v, k: clamp(v.k / 1.25) }))}>−</button>
      <button type="button" aria-label="Fit graph" onClick={() => setView({ x: 0, y: 0, k: 1 })}>⤢</button>
      <ul className="sp-graph-legend" aria-label="Legend">{Object.entries(palette).map(([kind, color]) =>
        <li key={kind}><span style={{ background: color }} />{kind}</li>)}</ul>
    </div>
    <div className="sp-graph-stage">
      <svg ref={svg} role="application" aria-label={label} className="sp-graph-svg" viewBox={`${-VIEW_W / 2} ${-VIEW_H / 2} ${VIEW_W} ${VIEW_H}`}
        onWheel={onWheel} onPointerMove={moveDrag} onPointerUp={endDrag}>
        <defs><marker id="sp-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" /></marker></defs>
        <rect data-testid="sp-graph-background" x={-5000} y={-5000} width={10000} height={10000} className="sp-graph-background"
          onPointerDown={event => startDrag(event)} onClick={() => { if (!endDrag()) onSelect(undefined); }} onDoubleClick={() => setPins(new Map())} />
        <g data-testid="sp-graph-scene" transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {links.map(l => {
            const from = layout.get(l.source), to = layout.get(l.target);
            if (!from || !to) return null;
            const group = pairs.get(pairKey(l.source, l.target))!;
            return <g key={l.id} className="sp-graph-link">
              <path id={`sp-link-${l.id}`} d={linkPath(from, to, group.indexOf(l.id), group.length)} markerEnd="url(#sp-graph-arrow)" />
              <text><textPath href={`#sp-link-${l.id}`} startOffset="50%" textAnchor="middle">{l.label}</textPath></text>
            </g>;
          })}
          {nodes.map(n => {
            const p = layout.get(n.id); if (!p) return null;
            return <g key={n.id} data-node-id={n.id} role="button" tabIndex={0} aria-label={`${n.caption}, ${n.kind}${n.muted ? ', ended' : ''}`}
              aria-pressed={selectedId === n.id} aria-expanded={expandedIds.has(n.id)} transform={`translate(${p.x},${p.y})`}
              className={`sp-graph-node${selectedId === n.id ? ' is-selected' : ''}${n.muted ? ' is-muted' : ''}`}
              onPointerDown={event => { event.stopPropagation(); startDrag(event, n.id); }}
              onClick={event => { event.stopPropagation(); if (!endDrag()) onSelect(n.id); }}
              onDoubleClick={event => { event.stopPropagation(); onToggleExpand(n.id); }}
              onKeyDown={event => onNodeKey(event, n.id)}>
              <circle r={NODE_RADIUS} style={{ fill: n.muted ? 'var(--sp-text-tertiary)' : palette[n.kind] }} />
              <text y={NODE_RADIUS + 14} textAnchor="middle">{cut(n.caption)}</text>
            </g>;
          })}
        </g>
      </svg>
      {selected && items.length > 0 && <div role="menu" aria-label="Node actions" className="sp-graph-menu"
        style={{ left: `${50 + ((selected.x * view.k + view.x) / VIEW_W) * 100}%`, top: `${50 + ((selected.y * view.k + view.y) / VIEW_H) * 100}%` }}>
        {items.map(item => <button key={item.label} type="button" role="menuitem" onClick={item.onClick}>{item.label}</button>)}
      </div>}
    </div>
    <ul className="sp-sr-only" aria-label={`${label} items`}>{nodes.map(n => <li key={n.id}>{n.caption} ({n.kind})</li>)}</ul>
  </div>;
}
