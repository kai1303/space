import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Menu, Popover } from './primitives.js';

afterEach(cleanup);
it.each([false, true])('retains the exiting menu, makes it inert, and restores focus (portal: %s)', async floating => {
  const select = vi.fn();
  render(<Menu label="Actions" floating={floating} items={[{ label: 'Choose', onSelect: select }]} />);
  const trigger = screen.getByRole('button', { name: 'Actions' });
  fireEvent.click(trigger);
  const panel = screen.getByRole('menu');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Choose' }));
  expect(select).toHaveBeenCalledOnce();
  expect(panel.isConnected).toBe(true);
  expect(panel.hasAttribute('inert')).toBe(true);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await waitFor(() => expect(panel.isConnected).toBe(false));
  await waitFor(() => expect(trigger.closest('details')?.open).toBe(false));
});
it('can reopen during exit, dismiss with Escape, and close on outside click', async () => {
  render(<Popover label="Emoji" trigger="Open">{close => <button onClick={close}>Pick</button>}</Popover>);
  const trigger = screen.getByRole('button', { name: 'Emoji' });
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.getByRole('button', { name: 'Pick' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Pick' }), { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
