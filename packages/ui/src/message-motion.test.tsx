import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Message } from './conversation.js';
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async importOriginal => ({ ...await importOriginal<typeof import('motion/react')>(), useReducedMotion: () => preference.reduced }));
afterEach(() => { cleanup(); preference.reduced = false; });
const message = (arrival = false) => <Message author="Kai" initials="KA" time="now" arrival={arrival}>A message</Message>;
it('fades a new message without translating or scaling its row', () => {
  render(message(true));
  const row = screen.getByText('A message').closest('article')!;
  expect(row.style.transform).not.toMatch(/translate|scale/);
  expect(row.style.opacity).toBe('0');
});
it('shows existing history immediately', () => {
  render(message());
  const row = screen.getByText('A message').closest('article')!;
  expect(row.style.opacity).toBe('1');
  expect(row.style.transform).not.toMatch(/translate|scale/);
});
it('shows new messages immediately when reduced motion is requested', () => {
  preference.reduced = true;
  render(message(true));
  expect(screen.getByText('A message').closest('article')!.style.opacity).toBe('1');
});
it('does not restart a completed fade on rerender', async () => {
  const view = render(message(true));
  const row = screen.getByText('A message').closest('article')!;
  await waitFor(() => expect(row.style.opacity).toBe('1'));
  view.rerender(message(true));
  expect(screen.getByText('A message').closest('article')).toBe(row);
  expect(row.style.opacity).toBe('1');
});
