import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Message } from './conversation.js';
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async importOriginal => ({ ...await importOriginal<typeof import('motion/react')>(), useReducedMotion: () => preference.reduced }));
afterEach(() => { cleanup(); preference.reduced = false; });
const message = (arrival: ComponentProps<typeof Message>['arrival'] = false) => <Message author="Kai" initials="KA" time="now" arrival={arrival}>A message</Message>;
it('fades a new message without translating or scaling its row', () => {
  render(message('fade'));
  const row = screen.getByText('A message').closest('article')!;
  expect(row.style.transform).not.toMatch(/translate|scale/);
  expect(row.style.opacity).toBe('0');
});
it.each([true, 'glide'] as const)('glides a new message in from the left when arrival is %s', async arrival => {
  render(message(arrival));
  const row = screen.getByText('A message').closest('article')!;
  expect(row.style.transform).toBe('translateX(-14px)');
  expect(row.style.opacity).toBe('0');
  await waitFor(() => {
    expect(row.style.transform).toBe('none');
    expect(row.style.opacity).toBe('1');
  });
});
it('shows existing history immediately', () => {
  render(message());
  const row = screen.getByText('A message').closest('article')!;
  expect(row.style.opacity).toBe('1');
  expect(row.style.transform).not.toMatch(/translate|scale/);
});
it.each(['fade', 'glide'] as const)('shows a new message immediately with reduced motion and %s arrival', arrival => {
  preference.reduced = true;
  render(message(arrival));
  const row = screen.getByText('A message').closest('article')!;
  expect(row.style.transform).not.toMatch(/translate|scale/);
  expect(row.style.opacity).toBe('1');
});
it('does not restart a completed fade on rerender', async () => {
  const view = render(message('fade'));
  const row = screen.getByText('A message').closest('article')!;
  await waitFor(() => expect(row.style.opacity).toBe('1'));
  view.rerender(message('fade'));
  expect(screen.getByText('A message').closest('article')).toBe(row);
  expect(row.style.opacity).toBe('1');
});
