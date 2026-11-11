import { describe, expect, it } from 'vitest';
import { ALPHA_MIN, GraphSimulation, type FrameScheduler } from './simulation.js';

function fakeFrames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  const frames: FrameScheduler = { request: cb => { const id = next++; queue.set(id, cb); return id; }, cancel: id => { queue.delete(id); } };
  const flush = (limit = 2000) => { let ran = 0; while (queue.size && ran < limit) { const [id, cb] = queue.entries().next().value!; queue.delete(id); cb(); ran++; } return ran; };
  return { frames, flush, pending: () => queue.size };
}
const nodes = [{ id: 'c' }, { id: 't1' }, { id: 't2' }];
const links = [{ id: 'a', source: 'c', target: 't1' }, { id: 'b', source: 'c', target: 't2' }];

describe('GraphSimulation', () => {
  it('pre-computes, animates the rest on frames, then stops requesting frames', () => {
    const f = fakeFrames(); let ticks = 0;
    const sim = new GraphSimulation(() => { ticks++; }, { frames: f.frames });
    sim.update(nodes, links);
    sim.update([...nodes, { id: 's1' }], [...links, { id: 'd', source: 't1', target: 's1' }]);
    expect(f.pending()).toBe(1);
    expect(f.flush()).toBeGreaterThan(1);
    expect(f.pending()).toBe(0);
    expect(sim.running).toBe(false);
    expect(sim.alpha).toBeLessThan(ALPHA_MIN);
    expect(ticks).toBeGreaterThan(2);
  });

  it('new nodes start next to their parent', () => {
    const f = fakeFrames();
    const sim = new GraphSimulation(() => {}, { frames: f.frames });
    sim.update(nodes, links); f.flush();
    const parent = sim.positions().get('t1')!;
    sim.update([...nodes, { id: 's1' }], [...links, { id: 'd', source: 't1', target: 's1' }]);
    const child = sim.positions().get('s1')!;
    expect(Math.hypot(child.x - parent.x, child.y - parent.y)).toBeLessThan(100);
  });

  it('dragging pins the node and moves its neighbours; release keeps the pin', () => {
    const f = fakeFrames();
    const sim = new GraphSimulation(() => {}, { frames: f.frames });
    sim.update(nodes, links); f.flush();
    const before = sim.positions().get('t1')!;
    const c = sim.positions().get('c')!;
    sim.drag('c', c.x + 300, c.y + 300);
    for (let i = 0; i < 40; i++) f.flush(1);
    const after = sim.positions().get('t1')!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(20);
    sim.release(); f.flush();
    expect(sim.positions().get('c')).toMatchObject({ x: c.x + 300, y: c.y + 300, pinned: true });
    expect(f.pending()).toBe(0);
    sim.unpin('c'); f.flush();
    expect(sim.positions().get('c')!.pinned).toBeUndefined();
  });

  it('reduced motion settles synchronously and never requests frames', () => {
    const f = fakeFrames();
    const sim = new GraphSimulation(() => {}, { frames: f.frames, reducedMotion: true });
    sim.update(nodes, links);
    sim.update([...nodes, { id: 's1' }], [...links, { id: 'd', source: 't1', target: 's1' }]);
    expect(f.pending()).toBe(0);
    expect(sim.alpha).toBeLessThan(ALPHA_MIN);
  });

  it('a small drag moves only the node; the layout restarts past the 25 px tolerance', () => {
    const f = fakeFrames();
    const sim = new GraphSimulation(() => {}, { frames: f.frames });
    sim.update(nodes, links); f.flush();
    const c = sim.positions().get('c')!;
    sim.dragStart('c', 100, 100);
    sim.drag('c', c.x + 10, c.y, 110, 100);
    expect(f.pending()).toBe(0);
    expect(sim.positions().get('c')!.x).toBe(c.x + 10);
    sim.drag('c', c.x + 40, c.y, 140, 100);
    expect(f.pending()).toBe(1);
    expect(sim.dragging).toBe(true);
    sim.release(); f.flush();
    expect(f.pending()).toBe(0);
  });

  it('a hovered node is held still and let go on leave without becoming pinned', () => {
    const f = fakeFrames();
    const sim = new GraphSimulation(() => {}, { frames: f.frames });
    sim.update(nodes, links); f.flush();
    sim.hold('t1');
    const held = sim.positions().get('t1')!;
    expect(held.pinned).toBeUndefined();
    sim.update([...nodes, { id: 's1' }], [...links, { id: 'd', source: 't1', target: 's1' }]); f.flush();
    expect(sim.positions().get('t1')).toEqual(held);
    sim.letGo('t1');
    sim.unpin(); f.flush();
    expect(sim.positions().get('t1')).not.toEqual(held);
  });

  it('removing nodes drops them and an unchanged update does not reheat', () => {
    const f = fakeFrames();
    const sim = new GraphSimulation(() => {}, { frames: f.frames });
    sim.update(nodes, links); f.flush();
    sim.update(nodes, links);
    expect(f.pending()).toBe(0);
    sim.update(nodes.slice(0, 2), links.slice(0, 1));
    expect(sim.positions().has('t2')).toBe(false);
  });
});
