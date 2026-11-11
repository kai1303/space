import { describe, expect, it } from 'vitest';
import { layoutGraph, linkPath, NODE_RADIUS } from './layout.js';

const nodes = [{ id: 'c' }, { id: 't1' }, { id: 't2' }, { id: 's1' }];
const links = [{ id: 'a', source: 'c', target: 't1' }, { id: 'b', source: 'c', target: 't2' }, { id: 'd', source: 't1', target: 's1' }];

describe('layoutGraph', () => {
  it('is deterministic, finite and keeps nodes apart', () => {
    const one = layoutGraph(nodes, links), two = layoutGraph(nodes, links);
    expect([...one.entries()]).toEqual([...two.entries()]);
    const points = [...one.values()];
    expect(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    for (const p of points) for (const q of points) if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(NODE_RADIUS * 1.5);
  });
  it('starts from previous positions and places new nodes', () => {
    const first = layoutGraph(nodes, links);
    const second = layoutGraph([...nodes, { id: 's2' }], [...links, { id: 'e', source: 't2', target: 's2' }], first);
    expect(second.get('s2')).toBeDefined();
    expect(Math.hypot(second.get('c')!.x - first.get('c')!.x, second.get('c')!.y - first.get('c')!.y)).toBeLessThan(80);
  });
  it('returns an empty map for no nodes', () => {
    expect(layoutGraph([], []).size).toBe(0);
  });
});

describe('linkPath', () => {
  it('draws a straight line edge to edge, and curves parallel links apart', () => {
    const a = { x: 0, y: 0 }, b = { x: 100, y: 0 };
    expect(linkPath(a, b, 0, 1)).toBe(`M${NODE_RADIUS},0L${100 - NODE_RADIUS},0`);
    expect(linkPath(a, b, 0, 2)).toMatch(/^M.+Q.+$/);
    expect(linkPath(a, b, 0, 2)).not.toBe(linkPath(a, b, 1, 2));
  });
});
