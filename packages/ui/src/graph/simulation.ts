import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { NODE_RADIUS, type Point } from './layout.js';

// Live force layout. It pre-computes most of the settling, animates the rest on animation
// frames, and stops once cool, so an idle graph schedules nothing.
export const ALPHA_MIN = 0.05, VELOCITY_DECAY = 0.4, PRECOMPUTE_TICKS = 300, TICKS_PER_FRAME = 1;
export const REHEAT_ALPHA = 0.3, DRAG_ALPHA_TARGET = 0.09;

type SimNode = SimulationNodeDatum & { id: string };
type SimLink = SimulationLinkDatum<SimNode> & { id: string };
export type FrameScheduler = { request(callback: () => void): number; cancel(handle: number): void };
const browserFrames: FrameScheduler = {
  request: callback => requestAnimationFrame(callback),
  cancel: handle => cancelAnimationFrame(handle),
};

function seeded(seed = 1) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

export class GraphSimulation {
  private readonly sim: Simulation<SimNode, SimLink>;
  private readonly byId = new Map<string, SimNode>();
  private frame: number | undefined;
  private dragging = false;

  constructor(private readonly onTick: (positions: Map<string, Point>) => void,
    private readonly options: { reducedMotion?: boolean; frames?: FrameScheduler } = {}) {
    this.sim = forceSimulation<SimNode, SimLink>([])
      .randomSource(seeded())
      .velocityDecay(VELOCITY_DECAY)
      .alphaMin(ALPHA_MIN)
      .force('charge', forceManyBody<SimNode>().strength(-420))
      .force('collide', forceCollide<SimNode>(NODE_RADIUS * 1.6))
      .force('x', forceX<SimNode>(0).strength(0.03))
      .force('y', forceY<SimNode>(0).strength(0.03))
      .stop();
  }

  get running() { return this.frame !== undefined; }
  get settled() { return !this.dragging && this.sim.alpha() < ALPHA_MIN; }
  get alpha() { return this.sim.alpha(); }

  positions(): Map<string, Point> {
    const round = (v: number) => Math.round(v * 10) / 10;
    return new Map([...this.byId].map(([id, n]) => [id, { x: round(n.x!), y: round(n.y!), ...(n.fx != null ? { pinned: true } : {}) }]));
  }

  // Keeps known nodes where they are; new nodes start next to their parent and spring out.
  update(nodes: { id: string }[], links: { id: string; source: string; target: string }[]) {
    const ids = new Set(nodes.map(n => n.id));
    const kept = links.filter(l => ids.has(l.source) && ids.has(l.target));
    const parent = new Map(kept.map(l => [l.target, l.source]));
    for (const id of [...this.byId.keys()]) if (!ids.has(id)) this.byId.delete(id);
    const fresh = nodes.filter(n => !this.byId.has(n.id));
    const firstRun = this.byId.size === 0;
    let placed = 0;
    for (const n of fresh) {
      const anchor = this.byId.get(parent.get(n.id) ?? '');
      const angle = placed++ * 2.399963;
      const distance = anchor ? NODE_RADIUS * 2.5 : NODE_RADIUS * 3 * Math.sqrt(placed);
      this.byId.set(n.id, { id: n.id, x: (anchor?.x ?? 0) + Math.cos(angle) * distance, y: (anchor?.y ?? 0) + Math.sin(angle) * distance });
    }
    this.sim.nodes(nodes.map(n => this.byId.get(n.id)!));
    this.sim.force('link', forceLink<SimNode, SimLink>(kept.map(l => ({ id: l.id, source: l.source, target: l.target }))).id(n => n.id).distance(NODE_RADIUS * 2 + 90));
    if (!fresh.length && kept.length === (this.sim.force('link') as ReturnType<typeof forceLink>).links().length && !firstRun) return;
    if (firstRun) this.settle(PRECOMPUTE_TICKS);
    this.reheat(firstRun ? this.sim.alpha() : REHEAT_ALPHA);
  }

  drag(id: string, x: number, y: number) {
    const node = this.byId.get(id); if (!node) return;
    node.fx = x; node.fy = y;
    if (!this.dragging) { this.dragging = true; this.sim.alphaTarget(DRAG_ALPHA_TARGET); this.reheat(Math.max(this.sim.alpha(), DRAG_ALPHA_TARGET * 2)); }
    else if (this.options.reducedMotion) this.reheat(this.sim.alpha());
  }
  release() {
    if (!this.dragging) return;
    this.dragging = false; this.sim.alphaTarget(0);
  }
  pin(id: string, point: Point) { const node = this.byId.get(id); if (node) { node.fx = point.x; node.fy = point.y; node.x = point.x; node.y = point.y; } }
  unpin(id?: string) {
    for (const node of id ? [this.byId.get(id)].filter(Boolean) as SimNode[] : this.byId.values()) { node.fx = null; node.fy = null; }
    this.reheat(REHEAT_ALPHA);
  }

  stop() {
    if (this.frame !== undefined) (this.options.frames ?? browserFrames).cancel(this.frame);
    this.frame = undefined;
  }

  private settle(maxTicks: number) {
    for (let tick = 0; tick < maxTicks && this.sim.alpha() >= ALPHA_MIN; tick++) this.sim.tick();
  }
  private reheat(alpha: number) {
    this.sim.alpha(alpha);
    if (this.options.reducedMotion) {
      this.settle(PRECOMPUTE_TICKS);
      this.onTick(this.positions());
      return;
    }
    this.onTick(this.positions());
    if (this.frame === undefined && (this.sim.alpha() >= ALPHA_MIN || this.dragging)) this.schedule();
  }
  private schedule() {
    const frames = this.options.frames ?? browserFrames;
    this.frame = frames.request(() => {
      this.frame = undefined;
      this.sim.tick(TICKS_PER_FRAME);
      this.onTick(this.positions());
      if (this.sim.alpha() >= ALPHA_MIN || this.dragging) this.schedule();
    });
  }
}
