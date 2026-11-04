import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Reveal } from './reveal.js';
import { ToolExecution } from '../agents/work-items.js';
import { WorkspaceSidebar } from '../navigation/sidebar.js';

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async importOriginal => ({
  ...await importOriginal<typeof import('motion/react')>(),
  useReducedMotion: () => preference.reduced,
}));
afterEach(() => { cleanup(); preference.reduced = false; });

it('keeps timeline content for the exit while immediately removing it from keyboard and screen-reader navigation', async () => {
  render(<ToolExecution completed points={[{ id: 'search', text: 'Searched messages', steps: [{ id: 'read', text: 'Read results', sourcesCount: 2, onViewSources() {} }] }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand timeline' }));
  const list = screen.getByRole('list');
  fireEvent.click(screen.getByRole('button', { name: 'Collapse timeline' }));
  expect(list.isConnected).toBe(true);
  expect(list.closest('[inert][aria-hidden="true"]')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'View sources' })).toBeNull();
  await waitFor(() => expect(list.isConnected).toBe(false));
});

it('animates the whole collapsed sidebar section and removes its rows from keyboard navigation', async () => {
  render(<WorkspaceSidebar workspace="Team" selectedId="general" width={220} onWidthChange={() => {}} onSelect={() => {}} channels={[
    { id: 'general', name: 'general', section: 'channels' },
    { id: 'engineering', name: 'engineering', section: 'channels' },
    { id: 'helper', name: 'Helper', section: 'apps' },
  ]} />);
  const selected = screen.getByRole('button', { name: 'general', exact: true });
  const other = screen.getByRole('button', { name: 'engineering', exact: true });
  fireEvent.click(screen.getByRole('button', { name: 'Channels', exact: true }));
  expect(screen.queryByRole('button', { name: 'general', exact: true })).toBeNull();
  expect(selected.closest('[inert][aria-hidden="true"]')).toBeTruthy();
  expect(other.isConnected).toBe(true);
  const helper = screen.getByRole('button', { name: 'Helper', exact: true });
  helper.focus();
  fireEvent.keyDown(helper, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Helper', exact: true }));
  expect(screen.queryByRole('button', { name: 'engineering', exact: true })).toBeNull();
  await waitFor(() => expect(other.isConnected).toBe(false));
  expect(selected.isConnected).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Channels', exact: true }));
  expect(screen.getByRole('button', { name: 'engineering', exact: true })).toBeTruthy();
});

it('removes sensitive content synchronously instead of retaining an exit', () => {
  const view = render(<Reveal open immediateExit><input aria-label="Code" value="one-time-code" readOnly /></Reveal>);
  const input = screen.getByLabelText('Code');
  view.rerender(<Reveal open={false} immediateExit><input aria-label="Code" value="one-time-code" readOnly /></Reveal>);
  expect(input.isConnected).toBe(false);
  expect(view.container.querySelector('input')).toBeNull();
});

it('renders reduced-motion content at full height without an entrance transform', () => {
  preference.reduced = true;
  const view = render(<Reveal open immediateExit><button>Action</button></Reveal>);
  const panel = view.container.firstElementChild as HTMLElement;
  expect(panel.style.height).toBe('auto');
  expect(panel.style.opacity).toBe('1');
  expect(panel.style.transform).toBe('');
});
