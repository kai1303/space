import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Select } from './select.js';

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async original => ({ ...await original<typeof import('motion/react')>(), useReducedMotion: () => preference.reduced }));
afterEach(() => { cleanup(); preference.reduced = false; });
const example = <Select aria-label="Provider" defaultValue="codex"><option value="codex">Codex</option><option value="kiro">Kiro</option></Select>;

it('retains the exiting list visually while removing it from interaction and restoring focus', async () => {
  render(example);
  const trigger = screen.getByRole('combobox');
  fireEvent.click(trigger);
  const panel = screen.getByRole('listbox').parentElement!;
  fireEvent.click(screen.getByRole('option', { name: 'Kiro' }));
  expect(trigger.textContent).toContain('Kiro');
  expect(document.activeElement).toBe(trigger);
  expect(panel.isConnected).toBe(true);
  expect(panel.hasAttribute('inert')).toBe(true);
  expect(screen.queryByRole('listbox')).toBeNull();
  await waitFor(() => expect(panel.isConnected).toBe(false));
});

it('reopens during exit without leaving a duplicate or inert list', async () => {
  render(example);
  const trigger = screen.getByRole('combobox');
  fireEvent.click(trigger);
  const panel = screen.getByRole('listbox').parentElement!;
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(panel.hasAttribute('inert')).toBe(true);
  fireEvent.click(trigger);
  expect(screen.getAllByRole('listbox')).toHaveLength(1);
  expect(screen.getByRole('listbox').parentElement).toBe(panel);
  expect(panel.hasAttribute('inert')).toBe(false);
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(panel.isConnected).toBe(false));
});

it('honors reduced motion without translation or scaling and still dismisses', async () => {
  preference.reduced = true;
  render(example);
  fireEvent.click(screen.getByRole('combobox'));
  const panel = screen.getByRole('listbox').parentElement!;
  expect(panel.style.transform).toBe('none');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  await waitFor(() => expect(panel.isConnected).toBe(false));
});
