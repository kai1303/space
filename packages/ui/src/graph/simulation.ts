import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { NODE_RADIUS, type Point } from './layout.js';

// Live force layout tuned to feel like the Neo4j Browser graph view (behaviour studied, code our own):
// - start hot (alpha 1), pre-compute up to 300 ticks or 250 ms, then animate the rest,
//   one tick plus 10 extra per frame, so the picture settles quickly;
// - charge −400, collide radius = node radius + 25, link distance = both radii + 90, centre pull 0.03;
// - a drag restarts the layout once the pointer travels 5 px (Neo4j compares the squared distance
//   with 25), so clicks never jolt the graph but any real drag wakes it at once; it then runs at
//   alpha 0.8 with alpha target 0.09 so neighbours swing along; release cools it;
// - nothing is ever pinned: a dragged node is held only while the pointer is down and floats
//   free again on release (Neo4j pins on click and drop; Space deliberately does not);
// - a hovered node is held still so it never slides out from under the pointer.
// It stops once alpha < 0.05, so an idle graph schedules nothing.
export const ALPHA_MIN = 0.05, VELOCITY_DECAY = 0.4, PRECOMPUTE_TICKS = 300, PRECOMPUTE_MS = 250, TICKS_PER_FRAME = 11;
export const START_ALPHA = 1, DRAG_ALPHA = 0.8, DRAG_ALPHA_TARGET = 0.09, DRAG_TOLERANCE = 5;
export const CHARGE = -400, CENTER_PULL = 0.03, COLLIDE_PADDING = 25, LINK_GAP = 90;

type SimNode = SimulationNodeDatum & { id: string; hoverHeld?: boolean };
type SimLink = SimulationLinkDatum<SimNode> & { id: string };
export type FrameScheduler = { request(callback: () => void): number; cancel(handle: number): void };
const browserFrames: FrameScheduler = {
  request: callback => requestAnimationFrame(callback),
  cancel: handle => cancelAnimationFrame(handle),
};
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function seeded(seed = 1) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

export class GraphSimulation {
  private readonly sim: Simulation<SimNode, SimLink>;
  private readonly byId = new Map<string, SimNode>();
  private frame: number | undefined;
  private drag_: { id: string; startX: number; startY: number; restarted: boolean } | undefined;

  constructor(private readonly onTick: (positions: Map<string, Point>) => void,
    private readonly options: { reducedMotion?: boolean; frames?: FrameScheduler } = {}) {
    this.sim = forceSimulation<SimNode, SimLink>([])
      .randomSource(seeded())
      .velocityDecay(VELOCITY_DECAY)
      .alphaMin(ALPHA_MIN)
      .force('charge', forceManyBody<SimNode>().strength(CHARGE))
      .force('collide', forceCollide<SimNode>(NODE_RADIUS + COLLIDE_PADDING))
      .force('x', forceX<SimNode>(0).strength(CENTER_PULL))
      .force('y', forceY<SimNode>(0).strength(CENTER_PULL))
      .stop();
  }

  get running() { return this.frame !== undefined; }
  get dragging() { return !!this.drag_?.restarted; }
  get settled() { return !this.dragging && this.sim.alpha() < ALPHA_MIN; }
  get alpha() { return this.sim.alpha(); }

  positions(): Map<string, Point> {
    const round = (v: number) => Math.round(v * 10) / 10;
    return new Map([...this.byId].map(([id, n]) => [id, { x: round(n.x!), y: round(n.y!) }]));
  }

  // Keeps known nodes where they are; new nodes start next to their parent and spring out.
  update(nodes: { id: string }[], links: { id: string; source: string; target: string }[]) {
    const ids = new Set(nodes.map(n => n.id));
    const kept = links.filter(l => ids.has(l.source) && ids.has(l.target));
    const parent = new Map(kept.map(l => [l.target, l.source]));
    const before = (this.sim.force('link') as ReturnType<typeof forceLink> | undefined)?.links().length ?? 0;
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
    this.sim.force('link', forceLink<SimNode, SimLink>(kept.map(l => ({ id: l.id, source: l.source, target: l.target })))
      .id(n => n.id).distance(NODE_RADIUS * 2 + LINK_GAP));
    if (!firstRun && !fresh.length && kept.length === before && nodes.length === this.sim.nodes().length) return;
    this.sim.alpha(START_ALPHA);
    // The first layout is pre-computed so the graph opens already in shape. Later additions
    // (an expand) animate from the parent so new nodes visibly spring out.
    if (firstRun) this.precompute();
    this.run();
  }

  // Drag: the node follows the pointer at once; the layout restarts only past the tolerance.
  dragStart(id: string, clientX: number, clientY: number) {
    if (!this.byId.has(id)) return;
    this.drag_ = { id, startX: clientX, startY: clientY, restarted: false };
  }
  drag(id: string, x: number, y: number, clientX?: number, clientY?: number) {
    const node = this.byId.get(id); if (!node) return;
    node.fx = x; node.fy = y; node.x = x; node.y = y; node.hoverHeld = false;
    const d = this.drag_ ?? (this.drag_ = { id, startX: clientX ?? 0, startY: clientY ?? 0, restarted: false });
    const travelled = clientX === undefined ? Infinity : Math.hypot(clientX - d.startX, (clientY ?? 0) - d.startY);
    if (!d.restarted && travelled > DRAG_TOLERANCE) {
      d.restarted = true;
      this.sim.alphaTarget(DRAG_ALPHA_TARGET).alpha(DRAG_ALPHA);
      this.run();
    } else if (!d.restarted || this.options.reducedMotion) this.run(false);
  }
  // Let go of the dragged node so it floats free; the layout cools down from here.
  release() {
    const d = this.drag_; this.drag_ = undefined;
    const node = d ? this.byId.get(d.id) : undefined;
    if (node) { node.fx = null; node.fy = null; node.hoverHeld = false; }
    if (d?.restarted) this.sim.alphaTarget(0);
    else if (node) { this.sim.alpha(Math.max(this.sim.alpha(), 0.1)); this.run(); }
  }

  // Hold a hovered node still so it doesn't slide away from the pointer; let go on leave.
  hold(id: string) {
    const node = this.byId.get(id);
    if (node && node.fx == null) { node.fx = node.x; node.fy = node.y; node.hoverHeld = true; }
  }
  letGo(id: string) {
    const node = this.byId.get(id);
    if (node?.hoverHeld) { node.fx = null; node.fy = null; node.hoverHeld = false; }
  }

  stop() {
    if (this.frame !== undefined) (this.options.frames ?? browserFrames).cancel(this.frame);
    this.frame = undefined;
  }

  private precompute() {
    const start = now();
    for (let tick = 0; tick < PRECOMPUTE_TICKS && this.sim.alpha() >= ALPHA_MIN; tick++) {
      this.sim.tick();
      if (!this.options.reducedMotion && now() - start >= PRECOMPUTE_MS) break;
    }
  }
  // animate=false only paints the current positions (e.g. a node moved under the pointer).
  private run(animate = true) {
    if (this.options.reducedMotion) {
      if (animate) for (let tick = 0; tick < PRECOMPUTE_TICKS && this.sim.alpha() >= Math.max(ALPHA_MIN, this.sim.alphaTarget()); tick++) this.sim.tick();
      this.onTick(this.positions());
      return;
    }
    this.onTick(this.positions());
    if (animate && this.frame === undefined && (this.sim.alpha() >= ALPHA_MIN || this.dragging)) this.schedule();
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
