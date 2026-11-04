import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Popover } from './primitives.js';
import { Select } from './select.js';

afterEach(cleanup);
function Example({ searchable = false, disabled = false }: { searchable?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState('');
  return <form aria-label="Example"><fieldset disabled={disabled}><label>Fruit<Select aria-label="Fruit" name="fruit" required searchable={searchable} value={value} onChange={e => setValue(e.target.value)}>
    <option value="">Choose fruit</option><option value="apple">Apple</option><option value="banana" disabled>Banana</option><option value="pear">Pear</option>
  </Select></label></fieldset><button type="submit">Save</button><button type="reset">Reset</button></form>;
}
it('selects with arrows, skips disabled options, submits values and restores focus', async () => {
  render(<Example />);
  const trigger = screen.getByRole('combobox', { name: 'Fruit' });
  trigger.focus();
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  expect(trigger.textContent).toContain('Apple');
  expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('fruit')).toBe('apple');
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  expect(trigger.textContent).toContain('Pear');
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole('listbox')).toBeNull();
});
it('supports Home, End, typeahead, Escape and Tab without changing cancelled values', async () => {
  render(<Example />);
  const trigger = screen.getByRole('combobox', { name: 'Fruit' });
  await userEvent.click(trigger);
  await userEvent.keyboard('{End}{Home}p{Escape}');
  expect(trigger.textContent).toContain('Choose fruit');
  expect(document.activeElement).toBe(trigger);
  await userEvent.click(trigger);
  await userEvent.keyboard('p{Enter}');
  expect(trigger.textContent).toContain('Pear');
  await userEvent.click(trigger);
  await userEvent.tab();
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
});
it('searches labels, handles empty results and selects with the keyboard', async () => {
  render(<Example searchable />);
  await userEvent.click(screen.getByRole('combobox', { name: 'Fruit', exact: true }));
  const search = screen.getByRole('combobox', { name: 'Search Fruit' });
  await userEvent.type(search, 'zzz');
  expect(screen.getByText('No matches')).toBeTruthy();
  await userEvent.clear(search);
  await userEvent.type(search, 'pear');
  await userEvent.keyboard('{ArrowDown}{Enter}');
  expect(screen.getByRole('combobox', { name: 'Fruit' }).textContent).toContain('Pear');
});
it('blocks required submission and focuses the visible control', async () => {
  render(<Example />);
  const form = screen.getByRole('form') as HTMLFormElement;
  act(() => { expect(form.checkValidity()).toBe(false); });
  expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Fruit' }));
  expect(screen.getByRole('combobox', { name: 'Fruit' }).getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('alert').textContent).toBeTruthy();
  await userEvent.click(screen.getByRole('option', { name: 'Apple', exact: true }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(form.checkValidity()).toBe(true);
});
it('respects disabled fieldsets and outside dismissal', async () => {
  const { rerender } = render(<Example disabled />);
  await userEvent.click(screen.getByRole('combobox', { name: 'Fruit' }));
  expect(screen.queryByRole('listbox')).toBeNull();
  rerender(<Example />);
  await userEvent.click(screen.getByRole('combobox', { name: 'Fruit' }));
  await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(screen.queryByRole('listbox')).toBeNull();
});
it('updates dynamic options and respects controlled values and native change events', async () => {
  const onChange = vi.fn();
  const { rerender } = render(<Select aria-label="Zone" value="a" onChange={onChange}><option value="a">Alpha</option></Select>);
  rerender(<Select aria-label="Zone" value="b" onChange={onChange}><option value="a">Alpha</option><option value="b">Beta</option></Select>);
  expect(screen.getByRole('combobox').textContent).toContain('Beta');
  await userEvent.click(screen.getByRole('combobox'));
  await userEvent.click(screen.getByRole('option', { name: 'Alpha' }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('combobox').textContent).toContain('Beta');
});

it('keeps a nested filter open while selecting and lets Escape close it afterwards', async () => {
  render(<Popover label="Filter" floating trigger="Filter" panelClassName="filters">{() => <Example />}</Popover>);
  await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
  const trigger = screen.getByRole('combobox', { name: 'Fruit' });
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole('option', { name: 'Apple' }));
  expect(screen.getByRole('combobox', { name: 'Fruit' })).toBe(trigger);
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Filter' }).getAttribute('aria-expanded')).toBe('false');
});
it('resets an uncontrolled form and closes an open list when its fieldset becomes disabled', async () => {
  const view = (disabled: boolean) => <form aria-label="Reset"><fieldset disabled={disabled}><Select aria-label="Fruit" name="fruit" defaultValue="apple"><option value="apple">Apple</option><option value="pear">Pear</option></Select></fieldset><button type="reset">Reset</button></form>;
  const { rerender } = render(view(false));
  await userEvent.click(screen.getByRole('combobox'));
  await userEvent.click(screen.getByRole('option', { name: 'Pear' }));
  await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(screen.getByRole('combobox').textContent).toContain('Apple');
  expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('fruit')).toBe('apple');
  await userEvent.click(screen.getByRole('combobox'));
  rerender(view(true));
  expect(screen.queryByRole('listbox')).toBeNull();
});
