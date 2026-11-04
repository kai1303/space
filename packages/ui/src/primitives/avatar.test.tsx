import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Avatar } from './primitives.js';
afterEach(cleanup);
it('renders a profile image and retains initials when that image cannot load', () => {
  const { container, rerender } = render(<Avatar name="Alex" initials="AL" image="/avatar.jpg" presence="online" />);
  const image = container.querySelector('img')!;
  expect(image.getAttribute('src')).toBe('/avatar.jpg');
  expect(screen.getByRole('img', { name: 'Alex, online' })).toBeTruthy();
  fireEvent.error(image);
  expect(image.hidden).toBe(true);
  expect(screen.getByText('AL')).toBeTruthy();
  rerender(<Avatar name="Alex" initials="AL" image="/new-avatar.jpg" presence="online" />);
  expect(container.querySelector('img')?.hidden).toBe(false);
});
