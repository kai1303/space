import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';

const auth = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock('./auth-client.js', () => ({ authClient: { signIn: { email: auth.signIn } } }));
const items = [{ id: 'one', name: 'Team' }, { id: 'two', name: 'Another team' }];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
async function addWorkspace() {
  await userEvent.click(screen.getByRole('button', { name: 'Switch workspaces… (Team)' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Add a workspace' }));
  return screen.findByRole('dialog', { name: 'Add a workspace' });
}

it('shows workspace names without addresses, other memberships and an add action', async () => {
  const change = vi.fn();
  render(<WorkspaceSwitcher items={items} value="one" onChange={change} onCreate={vi.fn()} />);
  const trigger = screen.getByRole('button', { name: 'Switch workspaces… (Team)' });
  expect(trigger.textContent).toContain('TE');
  await userEvent.click(trigger);
  const menu = screen.getByRole('menu', { name: 'Workspaces' });
  expect(within(menu).getByRole('menuitem', { name: 'Team' }).getAttribute('aria-current')).toBe('true');
  const current = within(menu).getByRole('menuitem', { name: 'Team' });
  expect(current.getAttribute('title')).toBeNull();
  expect(menu.textContent).not.toContain(window.location.host);
  expect(menu.textContent).not.toContain('?workspace=');
  await userEvent.click(within(menu).getByRole('menuitem', { name: 'Another team' }));
  expect(change).toHaveBeenCalledWith('two');
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
  await userEvent.click(trigger);
  await userEvent.keyboard('{Escape}');
  expect(document.activeElement).toBe(trigger);
});

it('shows logos for the current and other workspaces and falls back when a logo fails', async () => {
  const choices = [{ ...items[0], icon_url: '/team-logo.png' }, { ...items[1], icon_url: '/another-logo.png' }];
  const view = render(<WorkspaceSwitcher items={choices} value="one" onChange={vi.fn()} onCreate={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Switch workspaces… (Team)' }));
  const current = screen.getByRole('menuitem', { name: 'Team', exact: true });
  const other = screen.getByRole('menuitem', { name: 'Another team' });
  const logo = current.querySelector('img');
  expect(logo?.getAttribute('src')).toBe('/team-logo.png');
  expect(other.querySelector('img')?.getAttribute('src')).toBe('/another-logo.png');
  fireEvent.error(logo!);
  expect(logo?.hidden).toBe(true);
  expect(current.textContent).toContain('TE');
  view.rerender(<WorkspaceSwitcher items={[{ ...choices[0], icon_url: '/replacement.png' }, choices[1]]} value="one" onChange={vi.fn()} onCreate={vi.fn()} />);
  expect(current.querySelector('img')?.getAttribute('src')).toBe('/replacement.png');
  expect(current.querySelector('img')?.hidden).toBe(false);
});

it('opens the three Slack-style add choices and searches authorized workspaces', async () => {
  const change = vi.fn();
  render(<WorkspaceSwitcher items={items} value="one" onChange={change} onCreate={vi.fn()} />);
  const dialog = await addWorkspace();
  for (const name of ['Sign in to another workspace', 'Find workspaces', 'Create a new workspace']) {
    expect(within(dialog).getByRole('button', { name })).toBeTruthy();
  }
  await userEvent.click(within(dialog).getByRole('button', { name: 'Find workspaces' }));
  const search = screen.getByRole('searchbox', { name: 'Search workspaces' });
  await userEvent.type(search, 'another');
  expect(screen.queryByRole('button', { name: 'Open Team' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Open Another team' }));
  expect(change).toHaveBeenCalledWith('two');
});

it('shows a useful no-match state and lets users go back', async () => {
  render(<WorkspaceSwitcher items={items} value="one" onChange={vi.fn()} onCreate={vi.fn()} />);
  await addWorkspace();
  await userEvent.click(screen.getByRole('button', { name: 'Find workspaces' }));
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search workspaces' }), 'missing');
  expect(screen.getByText('No matching workspaces')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('button', { name: 'Create a new workspace' })).toBeTruthy();
});

it('retains create failures for retry and prevents duplicate submissions', async () => {
  const create = vi.fn().mockRejectedValueOnce(new Error('Name is unavailable'));
  render(<WorkspaceSwitcher items={items} value="one" onChange={vi.fn()} onCreate={create} />);
  await addWorkspace();
  await userEvent.click(screen.getByRole('button', { name: 'Create a new workspace' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Workspace name' }), '  New team  ');
  await userEvent.click(screen.getByRole('button', { name: 'Create workspace', exact: true }));
  expect((await screen.findByRole('alert')).textContent).toContain('Name is unavailable');
  let finish!: () => void;
  create.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await userEvent.dblClick(screen.getByRole('button', { name: 'Create workspace', exact: true }));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenLastCalledWith('New team');
  finish();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('reuses sign-in and refreshes the authenticated session after success', async () => {
  auth.signIn.mockResolvedValue({ error: null });
  const refreshed = vi.fn();
  window.addEventListener('space:session-expired', refreshed);
  render(<WorkspaceSwitcher items={items} value="one" onChange={vi.fn()} onCreate={vi.fn()} />);
  await addWorkspace();
  await userEvent.click(screen.getByRole('button', { name: 'Sign in to another workspace' }));
  expect(screen.getByText(/changes the account in this browser/)).toBeTruthy();
  await userEvent.type(screen.getByRole('textbox', { name: 'Email' }), 'person@example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'password1234');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in', exact: true }));
  expect(auth.signIn).toHaveBeenCalledWith({ email: 'person@example.com', password: 'password1234' });
  await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  window.removeEventListener('space:session-expired', refreshed);
});

it('blocks dismissing or restarting sign-in until the authentication request settles', async () => {
  let finish!: (result: { error: { message: string } }) => void;
  auth.signIn.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<WorkspaceSwitcher items={items} value="one" onChange={vi.fn()} onCreate={vi.fn()} />);
  await addWorkspace();
  await userEvent.click(screen.getByRole('button', { name: 'Sign in to another workspace' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Email' }), 'person@example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'password1234');
  await userEvent.dblClick(screen.getByRole('button', { name: 'Sign in', exact: true }));
  expect(auth.signIn).toHaveBeenCalledOnce();
  expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(screen.getByRole('dialog', { name: 'Sign in to another workspace' })).toBeTruthy();
  finish({ error: { message: 'Try signing in again' } });
  expect((await screen.findByRole('alert')).textContent).toContain('Try signing in again');
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('button', { name: 'Create a new workspace' })).toBeTruthy();
});
