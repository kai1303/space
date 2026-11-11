import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';

export const NODE_RADIUS = 28;
export const MAX_TICKS = 300;
export type Point = { x: number; y: number };
type SimNode = SimulationNodeDatum & { id: string };
type SimLink = SimulationLinkDatum<SimNode> & { id: string };

// Seeded so the same graph always settles the same way (stable tests, no jumping on refresh).
function seeded(seed = 1) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

export function layoutGraph(nodes: { id: string }[], links: { id: string; source: string; target: string }[], previous: ReadonlyMap<string, Point> = new Map()): Map<string, Point> {
  if (!nodes.length) return new Map();
  const ids = new Set(nodes.map(n => n.id));
  const kept = links.filter(l => ids.has(l.source) && ids.has(l.target));
  const parent = new Map(kept.map(l => [l.target, l.source]));
  const byId = new Map<string, SimNode>();
  const depth = (id: string): number => {
    let d = 0;
    for (let at = parent.get(id), seen = new Set([id]); at && !seen.has(at); at = parent.get(at)) { seen.add(at); d++; }
    return d;
  };
  const ordered = [...nodes].sort((a, b) => depth(a.id) - depth(b.id));
  const sim: SimNode[] = ordered.map((n, index) => {
    const known = previous.get(n.id);
    const node: SimNode = known
      ? { id: n.id, x: known.x, y: known.y }
      : (() => {
        const anchorId = parent.get(n.id);
        const anchor = anchorId ? byId.get(anchorId) : undefined;
        const angle = index * 2.399963; // golden angle spreads siblings
        const distance = anchor ? NODE_RADIUS * 4 : NODE_RADIUS * 3 * Math.sqrt(index);
        return { id: n.id, x: (anchor?.x ?? 0) + Math.cos(angle) * distance, y: (anchor?.y ?? 0) + Math.sin(angle) * distance };
      })();
    byId.set(n.id, node);
    return node;
  });
  const simLinks: SimLink[] = kept.map(l => ({ id: l.id, source: l.source, target: l.target }));
  const simulation = forceSimulation<SimNode, SimLink>(sim)
    .randomSource(seeded())
    .velocityDecay(0.4)
    .alphaMin(0.05)
    .force('charge', forceManyBody<SimNode>().strength(-420))
    .force('link', forceLink<SimNode, SimLink>(simLinks).id(n => n.id).distance(NODE_RADIUS * 2 + 90))
    .force('collide', forceCollide<SimNode>(NODE_RADIUS * 1.6))
    .force('x', forceX<SimNode>(0).strength(0.03))
    .force('y', forceY<SimNode>(0).strength(0.03))
    .stop();
  for (let tick = 0; tick < MAX_TICKS && simulation.alpha() >= simulation.alphaMin(); tick++) simulation.tick();
  const round = (v: number) => Math.round(v * 10) / 10;
  return new Map(nodes.map(n => {
    const s = byId.get(n.id)!;
    return [n.id, { x: round(s.x!), y: round(s.y!) }];
  }));
}

// Where a link's label sits: the curve midpoint, rotated to read left to right.
export function linkLabelAnchor(from: { x: number; y: number }, to: { x: number; y: number }, index: number, count: number) {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1, ux = dx / length, uy = dy / length;
  const bend = count <= 1 ? 0 : (index - (count - 1) / 2) * 36 || 18;
  const midX = (from.x + to.x) / 2 - uy * bend / 2, midY = (from.y + to.y) / 2 + ux * bend / 2;
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle > 90) angle -= 180; else if (angle < -90) angle += 180;
  return { x: Math.round(midX * 10) / 10, y: Math.round(midY * 10) / 10, angle: Math.round(angle * 10) / 10 };
}

// Donut slice between two radii, from start to end angle (radians, 0 = 3 o'clock, clockwise).
export function arcPath(inner: number, outer: number, start: number, end: number, pad = 0.03): string {
  const a0 = start + pad / 2, a1 = end - pad / 2, large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${Math.round(r * Math.cos(a) * 100) / 100},${Math.round(r * Math.sin(a) * 100) / 100}`;
  return `M${p(outer, a0)}A${outer},${outer} 0 ${large} 1 ${p(outer, a1)}L${p(inner, a1)}A${inner},${inner} 0 ${large} 0 ${p(inner, a0)}Z`;
}

// Edge to edge, so arrowheads sit on the circle. Parallel links between one pair bend apart.
export function linkPath(from: { x: number; y: number }, to: { x: number; y: number }, index: number, count: number): string {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length;
  const sx = from.x + ux * NODE_RADIUS, sy = from.y + uy * NODE_RADIUS, ex = to.x - ux * NODE_RADIUS, ey = to.y - uy * NODE_RADIUS;
  const round = (v: number) => Math.round(v * 10) / 10 + 0;
  if (count <= 1) return `M${round(sx)},${round(sy)}L${round(ex)},${round(ey)}`;
  const bend = (index - (count - 1) / 2) * 36 || 18;
  const mx = (sx + ex) / 2 - uy * bend, my = (sy + ey) / 2 + ux * bend;
  return `M${round(sx)},${round(sy)}Q${round(mx)},${round(my)} ${round(ex)},${round(ey)}`;
}
