import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiSelectMenu } from './multiselect-menu.js';

afterEach(cleanup);
const options = [{ value: 'pdf', label: 'PDFs' }, { value: 'image', label: 'Images' }, { value: 'audio', label: 'Audio' }];
function Example() {
  const [value, onChange] = useState(['pdf', 'image', 'audio']);
  return <><MultiSelectMenu label="File types" summary={`${value.length} Types`} options={options} value={value} onChange={onChange} /><button>After menu</button></>;
}
it('keeps independent selections and reset inside the open menu', async () => {
  render(<Example />);
  await userEvent.click(screen.getByRole('button', { name: 'File types: 3 Types' }));
  await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'PDFs' }));
  expect(screen.getByRole('menuitemcheckbox', { name: 'PDFs' }).getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('menuitemcheckbox', { name: 'Images' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('button', { name: 'File types: 2 Types' }).getAttribute('aria-expanded')).toBe('true');
  await userEvent.click(screen.getByRole('menuitem', { name: 'Reset Filters' }));
  expect(screen.getByRole('menuitemcheckbox', { name: 'PDFs' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByRole('menuitem', { name: 'Reset Filters' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'PDFs' })));
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});
it('supports arrows, Space, Home/End, typeahead and Escape focus return', async () => {
  render(<Example />);
  const trigger = screen.getByRole('button', { name: 'File types: 3 Types' });
  trigger.focus(); await userEvent.keyboard('{ArrowDown}');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'PDFs' })));
  await userEvent.keyboard(' ');
  expect(screen.getByRole('menuitemcheckbox', { name: 'PDFs' }).getAttribute('aria-checked')).toBe('false');
  await userEvent.keyboard('{End}');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Reset Filters' })));
  await userEvent.keyboard('{Home}');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'PDFs' })));
  await userEvent.keyboard('im');
  expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'Images' }));
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
it('dismisses on outside click and lets Tab continue after the trigger', async () => {
  render(<Example />);
  const trigger=screen.getByRole('button', { name: 'File types: 3 Types' });
  await userEvent.click(trigger); await userEvent.click(screen.getByRole('button', { name: 'After menu' }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  trigger.focus(); await userEvent.keyboard('{ArrowDown}');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'PDFs' })));
  await userEvent.tab();
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After menu' }));
});
