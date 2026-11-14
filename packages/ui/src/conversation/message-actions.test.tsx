import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from '../primitives/toast.js';
import { Message } from './conversation.js';

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
  await waitFor(() => expect(toast.getState().alert).toContain('Could not copy message'));
  await userEvent.click(screen.getByLabelText('More actions'));
  await userEvent.click(screen.getByText('Hello'));
  expect(screen.queryByRole('menu')).toBeNull();
});

it('keeps the latest save result when two messages finish out of order', async () => {
  let finishFirst!: () => void;
  const first = new Promise<void>(resolve => { finishFirst = resolve; });
  render(<>
    <Message author="Alex" initials="AL" time="12:00" actions={{ save: () => first }}>First</Message>
    <Message author="Kai" initials="KA" time="12:01" actions={{ save: async () => { throw new Error('Offline'); } }}>Second</Message>
  </>);
  for (const author of ['Alex', 'Kai']) {
    const toolbar = screen.getByRole('group', { name: `Message actions for ${author}` });
    await userEvent.click(within(toolbar).getByLabelText('More actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to saved' }));
    if (author === 'Alex') expect(toast.getState().status.trim()).toBe('Saving message…');
  }
  expect(toast.getState().alert).toContain('Try again');
  finishFirst();
  await first;
  expect(toast.getState().toasts.at(-1)?.type).toBe('error');
});

it('restores the reaction picker trigger after selecting an emoji', async () => {
  render(<><Message author="Kai" initials="KA" time="12:00" onReact={() => {}} actions={{ copyMessage: () => {} }}>Hello</Message><button>Next control</button></>);
  const addReaction = screen.getByRole('button', { name: 'Add reaction…' });
  await userEvent.click(addReaction);
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search emoji' }), 'tada');
  await userEvent.click(screen.getByRole('button', { name: '🎉 :tada:' }));
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

it('runs a message shortcut only while its menu is open', async () => {
  const edit = vi.fn();
  render(<Message author="Kai" initials="KA" time="12:00" actions={{edit}}>Draft</Message>);
  await userEvent.keyboard('e');
  expect(edit).not.toHaveBeenCalled();
  await userEvent.click(screen.getByLabelText('More actions'));
  await userEvent.keyboard('e');
  expect(edit).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
});
