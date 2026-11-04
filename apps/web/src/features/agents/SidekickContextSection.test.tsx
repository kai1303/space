import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { SidekickContextSection } from './SidekickContextSection.js';

afterEach(cleanup);
it('shows saved context as normal message rows in its own section', () => {
  render(<SidekickContextSection context={{channel_id:'channel',channel_name:'product',captured_at:'2026-11-04T09:00:00Z',messages:[{id:'one',thread_id:'thread',author:'Kai',text:'Check invitations before launch.',created_at:'2026-11-04T08:55:00Z',files:['checklist.txt']}]}}/>);
  const section=screen.getByRole('region',{name:'Selected messages'});
  expect(within(section).getByRole('heading',{name:'Selected messages'})).toBeTruthy();
  expect(within(section).getByText('#product')).toBeTruthy();
  expect(within(section).getByText('Check invitations before launch.').closest('article')?.classList.contains('sp-message')).toBe(true);
  expect(within(section).getByText('Kai')).toBeTruthy();
  expect(within(section).getByText('checklist.txt')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});
