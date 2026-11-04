import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceSidebar } from './sidebar.js';

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async importOriginal => ({
  ...await importOriginal<typeof import('motion/react')>(),
  useReducedMotion: () => preference.reduced,
}));
afterEach(() => { cleanup(); preference.reduced = false; });
function sidebar() {
  render(<WorkspaceSidebar workspace="Team" selectedId="general" channels={[{ id: 'general', name: 'general', section: 'channels' }]} width={220} onWidthChange={() => {}} onSelect={() => {}} />);
  const toggle = screen.getByRole('button', { name: 'Channels', exact: true });
  return { toggle, kind: toggle.querySelector<HTMLElement>('.sp-sidebar-section-kind')!, caret: toggle.querySelector<HTMLElement>('.sp-sidebar-section-caret')! };
}

it('transitions the group icon to its caret and back on hover', async () => {
  const { toggle, kind, caret } = sidebar();
  const user = userEvent.setup();
  await user.hover(toggle);
  await waitFor(() => expect(caret.style.opacity).toBe('1'));
  expect(kind.style.opacity).toBe('0');
  await user.unhover(toggle);
  await waitFor(() => expect(kind.style.opacity).toBe('1'));
  expect(caret.style.opacity).toBe('0');
});

it('rotates the same caret when a hovered group collapses', async () => {
  const { toggle, caret } = sidebar();
  await userEvent.hover(toggle);
  await waitFor(() => expect(caret.style.opacity).toBe('1'));
  await waitFor(() => expect(caret.style.transform).toContain('rotate(90deg)'));
  const svg = caret.querySelector('svg');
  fireEvent.click(toggle);
  await waitFor(() => expect(caret.style.transform).toBe('none'));
  expect(caret.querySelector('svg')).toBe(svg);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('uses the same icon swap for keyboard focus and restores it on blur', async () => {
  const { toggle, kind, caret } = sidebar();
  const user = userEvent.setup();
  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(toggle);
  await waitFor(() => expect(caret.style.opacity).toBe('1'));
  await user.tab();
  await waitFor(() => expect(kind.style.opacity).toBe('1'));
  expect(caret.style.opacity).toBe('0');
});

it('keeps reduced-motion icon swaps free of scaling', async () => {
  preference.reduced = true;
  const { toggle, kind, caret } = sidebar();
  await userEvent.hover(toggle);
  await waitFor(() => expect(caret.style.opacity).toBe('1'));
  expect(kind.style.transform).toBe('none');
  expect(caret.style.transform).not.toContain('scale');
});
