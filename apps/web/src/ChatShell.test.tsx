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

it('matches the eight-item rail while keeping search in the topbar and Admin as a menu', async () => {
  const navigate = vi.fn(), manage = vi.fn();
  render(<ChatShell name="Team" user="Kai" onHome={() => {}} onDirectMessages={() => {}} onActivity={() => {}} onSearch={() => {}} onMembers={() => {}} onNavigate={navigate} activeDestination="files" adminItems={[{label:'Manage members',onSelect:manage}]}><main>Files</main></ChatShell>);
  const rail = screen.getByRole('navigation', {name:'Main navigation'});
  const {within} = await import('@testing-library/react');
  for (const name of ['Spacebot','DMs','Activity','Files','To-dos','Agents & tools','Admin']) expect(within(rail).getByRole('button',{name,exact:true})).toBeTruthy();
  expect(within(rail).getByRole('link',{name:'Home'}).getAttribute('aria-current')).toBeNull();
  expect(within(rail).queryByRole('button',{name:'Search',exact:true})).toBeNull();
  expect(within(rail).queryByRole('button',{name:'Members',exact:true})).toBeNull();
  expect(screen.getByRole('button',{name:'Files',exact:true}).getAttribute('aria-current')).toBe('page');
  await userEvent.click(screen.getByRole('button',{name:'Agents & tools',exact:true}));
  expect(navigate).toHaveBeenCalledWith('agents');
  await userEvent.click(screen.getByRole('button',{name:'Admin',exact:true}));
  await userEvent.click(screen.getByRole('menuitem',{name:'Manage members'}));
  expect(manage).toHaveBeenCalledOnce();
});
