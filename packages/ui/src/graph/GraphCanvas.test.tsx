import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { captionLines, GraphCanvas, NODE_RADIUS, type GraphNode, type GraphLink } from './index.js';

afterEach(cleanup);
const nodes: GraphNode[] = [
  { id: 'c', kind: 'channel', caption: '#payments' },
  { id: 't', kind: 'thread', caption: 'Dedupe fix · in progress with a very long caption here' },
  { id: 's', kind: 'session', caption: 'Codex', muted: true },
];
const links: GraphLink[] = [{ id: 'ct', source: 'c', target: 't', label: 'HAS' }, { id: 'ts', source: 't', target: 's', label: 'HAS_SESSION' }];
const palette = { channel: 'var(--sp-accent)', thread: 'var(--sp-success)', session: 'var(--sp-warning)' };
function setup(extra: Partial<Parameters<typeof GraphCanvas>[0]> = {}) {
  const onSelect = vi.fn(), onToggleExpand = vi.fn();
  const view = render(<GraphCanvas label="Channel memory graph" nodes={nodes} links={links} palette={palette} expandedIds={new Set()} onSelect={onSelect} onToggleExpand={onToggleExpand} {...extra} />);
  return { onSelect, onToggleExpand, view };
}
const node = (name: RegExp | string) => screen.getByRole('button', { name });

it('renders accessible nodes with captions inside the circle and named links', () => {
  setup();
  expect(screen.getByRole('application', { name: 'Channel memory graph' })).toBeTruthy();
  expect(node('#payments, channel')).toBeTruthy();
  expect(node('Codex, session, ended')).toBeTruthy();
  expect(screen.getByText('HAS_SESSION')).toBeTruthy();
  const caption = node(/^Dedupe fix/).querySelector('.sp-graph-caption')!;
  expect(caption.getAttribute('y')).toBeNull();
  const spans = [...caption.querySelectorAll('tspan')];
  expect(spans.length).toBe(3);
  for (const span of spans) expect(Math.abs(Number(span.getAttribute('y')))).toBeLessThan(NODE_RADIUS);
  expect(spans.at(-1)!.textContent!.endsWith('…')).toBe(true);
});

it('captionLines wraps to two short lines and cuts with an ellipsis', () => {
  expect(captionLines('Codex')).toEqual(['Codex']);
  expect(captionLines('Thread 9 · in progress')).toEqual(['Thread 9', 'in', 'progress']);
  expect(captionLines('Dedupe fix in progress and more')).toEqual(['Dedupe fix', 'in', 'progress…']);
  expect(captionLines('Supercalifragilistic')).toEqual(['Supercali…']);
});

it('link labels are upright and sit in a gap in the line', () => {
  const { view } = setup();
  const link = view.container.querySelector('[data-link-id="ts"]')!;
  const transform = link.querySelector('g')!.getAttribute('transform')!;
  const angle = Number(/rotate\((-?[\d.]+)\)/.exec(transform)![1]);
  expect(Math.abs(angle)).toBeLessThanOrEqual(90);
  expect(link.querySelector('.sp-graph-link-gap')).toBeTruthy();
});

it('click selects, double-click and Enter toggle expand, background click clears', () => {
  const { onSelect, onToggleExpand } = setup();
  const thread = node(/^Dedupe fix/);
  fireEvent.click(thread);
  expect(onSelect).toHaveBeenLastCalledWith('t');
  fireEvent.doubleClick(thread);
  fireEvent.keyDown(thread, { key: 'Enter' });
  expect(onToggleExpand).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByTestId('sp-graph-background'));
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
});

it('a click fixes the node in place, and clicking the selected node deselects it', () => {
  const { onSelect, view } = setup({ selectedId: 't' });
  const thread = node(/^Dedupe fix/);
  fireEvent.click(thread);
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
  fireEvent.click(node('Codex, session, ended'));
  expect(onSelect).toHaveBeenLastCalledWith('s');
  expect(view.container.querySelector('[data-node-id="s"]')!.classList.contains('is-pinned')).toBe(true);
});

it('arrow keys move focus along links', () => {
  setup();
  const channel = node('#payments, channel');
  channel.focus();
  fireEvent.keyDown(channel, { key: 'ArrowRight' });
  expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Dedupe fix/);
});

it('the ring menu is a donut of equal slices around the selected node and runs actions', () => {
  const open = vi.fn(), hide = vi.fn();
  setup({ selectedId: 't', menu: id => [{ label: 'Open thread', icon: 'open', onClick: () => open(id) }, { label: 'Hide', icon: '✕', onClick: hide }] });
  const ring = screen.getByRole('menu', { name: 'Node actions' });
  const slices = within(ring).getAllByRole('menuitem');
  expect(slices).toHaveLength(2);
  expect(slices[0]!.querySelector('.sp-graph-ring-icon')).toBeTruthy();
  expect(slices[1]!.querySelector('text')!.textContent).toBe('✕');
  // The first slice starts at 12 o'clock: its outer edge begins just right of straight up.
  const [, sx, sy] = /^M(-?[\d.]+),(-?[\d.]+)/.exec(slices[0]!.querySelector('path')!.getAttribute('d')!)!.map(Number);
  expect(sy!).toBeLessThan(0);
  expect(Math.abs(sx!)).toBeLessThan(2);
  for (const slice of slices) expect(slice.querySelector('path')!.getAttribute('d')).toMatch(/^M.+A.+L.+A.+Z$/);
  expect(slices[0]!.querySelector('title')!.textContent).toBe('Open thread');
  fireEvent.click(within(ring).getByRole('menuitem', { name: 'Open thread' }));
  expect(open).toHaveBeenCalledWith('t');
  fireEvent.keyDown(within(ring).getByRole('menuitem', { name: 'Hide' }), { key: 'Enter' });
  expect(hide).toHaveBeenCalled();
});

it('dragging a node pins it, adds Unpin to the ring, and Unpin frees it', () => {
  const { view } = setup({ selectedId: 'c', menu: () => [] });
  const channel = node('#payments, channel');
  const svg = screen.getByRole('application');
  fireEvent.pointerDown(channel, { clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(svg, { clientX: 80, clientY: 40, pointerId: 1 });
  fireEvent.pointerUp(svg, { pointerId: 1 });
  expect(view.container.querySelector('[data-node-id="c"]')!.classList.contains('is-pinned')).toBe(true);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }));
  expect(view.container.querySelector('[data-node-id="c"]')!.classList.contains('is-pinned')).toBe(false);
});

it('hover fades nodes and links that are not connected', () => {
  const { view } = setup();
  fireEvent.pointerEnter(node('Codex, session, ended'));
  expect(node('#payments, channel').classList.contains('is-faded')).toBe(true);
  expect(node(/^Dedupe fix/).classList.contains('is-faded')).toBe(false);
  expect(view.container.querySelector('[data-link-id="ct"]')!.classList.contains('is-faded')).toBe(true);
  expect(view.container.querySelector('[data-link-id="ts"]')!.classList.contains('is-faded')).toBe(false);
  fireEvent.pointerLeave(node('Codex, session, ended'));
  expect(node('#payments, channel').classList.contains('is-faded')).toBe(false);
});

it('zoom buttons change the scale and fit restores the fitted view', () => {
  setup();
  const scene = screen.getByTestId('sp-graph-scene');
  const before = scene.getAttribute('transform');
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  expect(scene.getAttribute('transform')).not.toBe(before);
  fireEvent.click(screen.getByRole('button', { name: 'Fit graph' }));
  expect(scene.getAttribute('transform')).toBe(before);
});

it('shows a collapsible details panel inside the canvas', async () => {
  setup({ details: <p>Thread details</p> });
  const panel = screen.getByRole('complementary', { name: 'Details' });
  expect(within(panel).getByText('Thread details')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Hide details' }));
  await waitFor(() => expect(within(panel).queryByText('Thread details')).toBeNull());
});

it('added nodes and links animate in with motion; the first paint does not', async () => {
  const { view } = setup();
  const firstScale = view.container.querySelector('[data-node-id="s"] > g')!;
  expect(firstScale.getAttribute('style') ?? '').not.toMatch(/scale\(0\)/);
  view.rerender(<GraphCanvas label="Channel memory graph" nodes={[...nodes, { id: 'n', kind: 'session', caption: 'New' }]}
    links={[...links, { id: 'tn', source: 't', target: 'n', label: 'HAS_SESSION' }]} palette={palette} expandedIds={new Set()} onSelect={() => {}} onToggleExpand={() => {}} />);
  expect(node('New, session')).toBeTruthy();
  expect(view.container.querySelector('[data-node-id="n"] > g')!.getAttribute('style') ?? '').toMatch(/scale\(0\)/);
  expect(view.container.querySelector('[data-link-id="tn"] path')).toBeTruthy();
  await waitFor(() => expect(view.container.querySelector('[data-node-id="n"] > g')!.getAttribute('style') ?? '').not.toMatch(/scale\(0\)/));
});

it('removed nodes leave through an exit animation', async () => {
  const { view } = setup();
  view.rerender(<GraphCanvas label="Channel memory graph" nodes={nodes.slice(0, 2)} links={links.slice(0, 1)} palette={palette} expandedIds={new Set()} onSelect={() => {}} onToggleExpand={() => {}} />);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Codex, session, ended' })).toBeNull());
  expect(view.container.querySelector('[data-link-id="ts"]')).toBeNull();
});

it('refuses more than 500 nodes', () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, kind: 'thread', caption: `n${i}` }));
  render(<GraphCanvas label="Big" nodes={many} links={[]} palette={palette} expandedIds={new Set()} onSelect={() => {}} onToggleExpand={() => {}} />);
  expect(screen.getByRole('status').textContent).toMatch(/too many items/i);
});

it('wheel zoom keeps the scene point under the pointer still', () => {
  setup();
  const svg = screen.getByRole('application');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  const scene = screen.getByTestId('sp-graph-scene');
  const read = () => { const [, x, y, k] = /translate\((-?[\d.]+),(-?[\d.]+)\) scale\(([\d.]+)\)/.exec(scene.getAttribute('transform')!)!.map(Number); return { x: x!, y: y!, k: k! }; };
  const px = 600 - 400, py = 450 - 300;
  const before = read();
  fireEvent.wheel(svg, { clientX: 600, clientY: 450, deltaY: 100 });
  const after = read();
  expect(after.k).toBeLessThan(before.k);
  expect((px - after.x) / after.k).toBeCloseTo((px - before.x) / before.k, 6);
  expect((py - after.y) / after.k).toBeCloseTo((py - before.y) / before.k, 6);
});
