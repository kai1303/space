import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GraphCanvas, type GraphNode, type GraphLink } from './index.js';

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
  render(<GraphCanvas label="Channel memory graph" nodes={nodes} links={links} palette={palette} expandedIds={new Set()} onSelect={onSelect} onToggleExpand={onToggleExpand} {...extra} />);
  return { onSelect, onToggleExpand };
}

it('renders accessible nodes, cut captions and named links', () => {
  setup();
  expect(screen.getByRole('application', { name: 'Channel memory graph' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '#payments, channel' })).toBeTruthy();
  expect(screen.getByText('Dedupe fix · in progress…')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Codex, session, ended' })).toBeTruthy();
  expect(screen.getByText('HAS_SESSION')).toBeTruthy();
});

it('click selects, double-click and Enter toggle expand, background click clears', () => {
  const { onSelect, onToggleExpand } = setup();
  const thread = screen.getByRole('button', { name: /^Dedupe fix/ });
  fireEvent.click(thread);
  expect(onSelect).toHaveBeenLastCalledWith('t');
  fireEvent.doubleClick(thread);
  fireEvent.keyDown(thread, { key: 'Enter' });
  expect(onToggleExpand).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByTestId('sp-graph-background'));
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
});

it('arrow keys move focus along links, and the ring menu runs actions', () => {
  const open = vi.fn();
  setup({ selectedId: 't', menu: id => [{ label: 'Open thread', onClick: () => open(id) }] });
  const channel = screen.getByRole('button', { name: '#payments, channel' });
  channel.focus();
  fireEvent.keyDown(channel, { key: 'ArrowRight' });
  expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Dedupe fix/);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open thread' }));
  expect(open).toHaveBeenCalledWith('t');
});

it('zoom buttons change the scale and fit resets it', () => {
  setup();
  const scene = screen.getByTestId('sp-graph-scene');
  const before = scene.getAttribute('transform');
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(scene.getAttribute('transform')).not.toBe(before);
  fireEvent.click(screen.getByRole('button', { name: 'Fit graph' }));
  expect(scene.getAttribute('transform')).toBe(before);
});

it('refuses more than 500 nodes', () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, kind: 'thread', caption: `n${i}` }));
  render(<GraphCanvas label="Big" nodes={many} links={[]} palette={palette} expandedIds={new Set()} onSelect={() => {}} onToggleExpand={() => {}} />);
  expect(screen.getByRole('status').textContent).toMatch(/too many items/i);
});
