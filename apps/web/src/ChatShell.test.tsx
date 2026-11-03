import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatShell, WorkspacePicker } from './ChatShell.js';

vi.mock('./AuthScreen.js', () => ({ SignOutButton: () => <button>Sign out</button> }));
afterEach(cleanup);
const workspaces = [{ id: 'one', name: 'Team' }, { id: 'two', name: 'Another team' }];

it('uses a keyboard-accessible workspace popover instead of a native select', async () => {
  const change = vi.fn(), members = vi.fn();
  render(<WorkspacePicker items={workspaces} value="one" onChange={change} onMembers={members} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Team Actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Another team' }));
  expect(change).toHaveBeenCalledWith('two');
  await userEvent.click(screen.getByRole('button', { name: 'Team Actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Workspace members' }));
  expect(members).toHaveBeenCalledOnce();
});

it('opens workspace switching from the rail and connects navigation history controls', async () => {
  const change = vi.fn(), back = vi.fn(), forward = vi.fn(), visit = vi.fn();
  render(<ChatShell name="Team" user="Kai" workspaces={workspaces} workspace="one" onWorkspaceChange={change} onBack={back} onForward={forward} history={[{ label: '#general · Team', onSelect: visit }]}><main>Conversation</main></ChatShell>);
  await userEvent.click(screen.getByRole('button', { name: 'Switch workspaces… (Team)' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Another team' }));
  expect(change).toHaveBeenCalledWith('two');
  await userEvent.click(screen.getByRole('button', { name: 'Back in history' }));
  await userEvent.click(screen.getByRole('button', { name: 'Forward in history' }));
  expect(back).toHaveBeenCalledOnce(); expect(forward).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'Show history' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '#general · Team' }));
  expect(visit).toHaveBeenCalledOnce();
});
