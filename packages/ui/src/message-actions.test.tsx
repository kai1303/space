import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Message } from './index.js';

afterEach(cleanup);

it('reports quick reactions and only offers menu actions supplied by the caller', async () => {
  const react = vi.fn(), copy = vi.fn(), edit = vi.fn();
  render(<Message author="Kai" initials="KA" time="12:00" onReact={react} actions={{ copyMessage: copy, edit }} onReply={() => {}}>Hello</Message>);
  await userEvent.click(screen.getByRole('button', { name: 'React with eyes' }));
  expect(react).toHaveBeenCalledWith('👀');
  await userEvent.click(screen.getByLabelText('More actions'));
  const menu = screen.getByRole('menu', { name: 'Message actions' });
  expect(within(menu).queryByRole('menuitem', { name: /Delete message/ })).toBeNull();
  await userEvent.click(within(menu).getByRole('menuitem', { name: /Copy message/ }));
  expect(copy).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
});

it('keeps the menu usable from the keyboard and restores trigger focus on Escape', async () => {
  const copy = vi.fn();
  render(<Message author="Kai" initials="KA" time="12:00" actions={{ copyLink: copy, copyMessage: copy }}>Hello</Message>);
  const more = screen.getByLabelText('More actions');
  await userEvent.click(more);
  await userEvent.keyboard('{ArrowDown}');
  await waitFor(() => expect(document.activeElement?.textContent).toContain('Copy link'));
  await userEvent.keyboard('{End}');
  await waitFor(() => expect(document.activeElement?.textContent).toContain('Copy message'));
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(more);
});

it('shows action failures and dismisses menus when clicking outside', async () => {
  render(<Message author="Kai" initials="KA" time="12:00" actions={{ copyMessage: async () => { throw new Error('Clipboard unavailable'); } }}>Hello</Message>);
  await userEvent.click(screen.getByLabelText('More actions'));
  await userEvent.click(screen.getByRole('menuitem', { name: /Copy message/ }));
  expect((await screen.findByRole('alert')).textContent).toContain('Could not copy message');
  await userEvent.click(screen.getByLabelText('More actions'));
  await userEvent.click(screen.getByText('Hello'));
  expect(screen.queryByRole('menu')).toBeNull();
});

it('restores the reaction picker trigger after selecting an emoji', async () => {
  render(<><Message author="Kai" initials="KA" time="12:00" onReact={() => {}} actions={{ copyMessage: () => {} }}>Hello</Message><button>Next control</button></>);
  const addReaction = screen.getByRole('button', { name: 'Add reaction…' });
  await userEvent.click(addReaction);
  await userEvent.click(screen.getByRole('menuitem', { name: 'React 🎉' }));
  expect(document.activeElement).toBe(addReaction);
});

it('continues Tab navigation after the menu trigger', async () => {
  render(<><Message author="Kai" initials="KA" time="12:00" onReact={() => {}} actions={{ copyMessage: () => {} }}>Hello</Message><button>Next control</button></>);
  await userEvent.click(screen.getByLabelText('More actions'));
  await userEvent.keyboard('{ArrowDown}');
  await waitFor(() => expect(document.activeElement?.textContent).toContain('Copy message'));
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next control' }));
});
