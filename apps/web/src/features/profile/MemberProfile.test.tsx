import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileProvider, useMemberProfile } from './MemberProfile.js';
import { WorkspaceDestinations } from '../workspace/collections/WorkspaceDestinations.js';
import { ConversationMessage } from '../chat/ThreadConversation.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const updates = vi.hoisted(() => ({ read: undefined as undefined | (() => unknown), revoke: undefined as undefined | ((code: string) => void) }));
vi.mock('../../shared/api/request.js', () => api);
vi.mock('../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: (_scope: string, _id: string, read: () => unknown, revoke: (code: string) => void) => {
  updates.read = read; updates.revoke = revoke; void read(); return () => {};
} }));
const person = { kind: 'user', id: 'ada', display_name: 'Ada', full_name: 'Ada Lovelace', title: 'Engineer', name_pronunciation: '', phone: '123', time_zone: 'UTC', image: null, email: 'ada@example.test', presence: 'active', status: null };
const agent = { kind: 'agent', id: 'bot', display_name: 'Codex', image: null, owner_id: 'me', owner_name: 'Kai', enabled: true, availability: 'online', can_message: true };
function Triggers() {
  const profiles = useMemberProfile();
  return <><button onClick={() => profiles?.open({kind:'user',id:'ada'})}>Open Ada</button><button onClick={() => profiles?.open({kind:'agent',id:'bot'})}>Open Codex</button><input aria-label="Conversation draft" defaultValue="Keep my draft" /></>;
}
const onMessage = vi.fn(), onConnection = vi.fn();
function mount(workspace = 'workspace') { return render(<ProfileProvider workspace={workspace} viewer="me" onMessage={onMessage} onConnection={onConnection}><Triggers /></ProfileProvider>); }
beforeEach(() => { api.request.mockImplementation(async (path: string) => path.endsWith('/direct-messages') ? {id:'dm'} : path.endsWith('/agent/bot') ? agent : person); onMessage.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); vi.resetAllMocks(); });

it('opens a linked profile in its workspace and does not reopen it after switching workspaces', async () => {
  const id = '00000000-0000-4000-8000-000000000002';
  window.history.replaceState(null, '', `/?workspace=workspace&profile=user:${id}`);
  api.request.mockResolvedValue({...person, id});
  const view = mount();
  await screen.findByRole('heading', {name:'Ada Lovelace'});
  expect(api.request.mock.calls[0]?.[0]).toBe(`/workspaces/workspace/profiles/user/${id}`);
  view.rerender(<ProfileProvider workspace="other" viewer="me" onMessage={onMessage} onConnection={onConnection}><Triggers /></ProfileProvider>);
  await waitFor(() => expect(screen.queryByRole('region', {name:'Profile'})).toBeNull());
  view.rerender(<ProfileProvider workspace="workspace" viewer="me" onMessage={onMessage} onConnection={onConnection}><Triggers /></ProfileProvider>);
  expect(screen.queryByRole('region', {name:'Profile'})).toBeNull();
});

it('opens a non-modal profile, preserves the draft, messages by resolved identity and restores focus on Escape', async () => {
  mount(); const trigger = screen.getByRole('button', {name:'Open Ada'});
  await userEvent.click(trigger);
  const panel = await screen.findByRole('region', {name:'Profile'});
  expect(panel.getAttribute('aria-modal')).toBeNull();
  await screen.findByRole('heading', {name:'Ada Lovelace'});
  expect(screen.getByRole('link', {name:'ada@example.test'}).getAttribute('href')).toBe('mailto:ada@example.test');
  expect((screen.getByLabelText('Conversation draft') as HTMLInputElement).value).toBe('Keep my draft');
  await userEvent.click(screen.getByRole('button', {name:'Message Ada'}));
  expect(onMessage).toHaveBeenCalledWith(person, 'dm');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('region', {name:'Profile'})).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it('replaces profiles and ignores responses that arrive after a new selection or revocation', async () => {
  let resolve!: (data: unknown) => void;
  api.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mount(); await userEvent.click(screen.getByText('Open Ada')); await userEvent.click(screen.getByText('Open Codex'));
  await screen.findByRole('heading', {name:'Codex'});
  await act(async () => { resolve(person); });
  expect(screen.queryByRole('heading', {name:'Ada Lovelace'})).toBeNull();
  act(() => updates.revoke?.('not_found'));
  expect(screen.queryByRole('heading', {name:'Codex'})).toBeNull();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('button', {name:'Message Codex'})).toBeNull();
});

it('clears stale fields during failed refreshes, supports retry, and closes on workspace changes', async () => {
  const view = mount(); await userEvent.click(screen.getByText('Open Ada')); await screen.findByRole('heading', {name:'Ada Lovelace'});
  api.request.mockRejectedValueOnce(new Error('network_unavailable'));
  await act(async () => { await updates.read?.(); });
  expect(screen.queryByText('ada@example.test')).toBeNull();
  await userEvent.click(screen.getByRole('button', {name:'Retry'}));
  await screen.findByRole('heading', {name:'Ada Lovelace'});
  view.rerender(<ProfileProvider workspace="other" viewer="me" onMessage={onMessage} onConnection={onConnection}><Triggers /></ProfileProvider>);
  expect(screen.queryByRole('region', {name:'Profile'})).toBeNull();
});

it('only exposes connection management to the owner and keeps messaging errors in the panel', async () => {
  mount(); await userEvent.click(screen.getByText('Open Codex')); await screen.findByRole('heading', {name:'Codex'});
  api.request.mockRejectedValueOnce(new Error('agent_not_ready'));
  await userEvent.click(screen.getByRole('button', {name:'Message Codex'}));
  expect((await screen.findByRole('alert')).textContent).toContain('agent not ready');
  await userEvent.click(screen.getByRole('button', {name:'View connection'}));
  expect(onConnection).toHaveBeenCalledWith('bot');
  api.request.mockResolvedValue({...agent, owner_id:'someone', can_message:false});
  await act(async () => { await updates.read?.(); });
  expect(screen.queryByRole('button', {name:'View connection'})).toBeNull();
  expect(screen.queryByRole('button', {name:'Message Codex'})).toBeNull();
});

it('opens people from directory cards and message names and avatars through the same panel', async () => {
  api.request.mockImplementation(async (path: string) => path.includes('/participants') ? { items: [{id:'ada',kind:'human',name:'Ada'}], next_cursor:null } : person);
  const message = {id:'message',channel_id:'channel',thread_id:'thread',created_at:'2026-11-06T00:00:00Z',text:'Hello',author:{id:'ada',name:'Ada',kind:'human' as const}};
  render(<ProfileProvider workspace="workspace" viewer="me" onMessage={onMessage} onConnection={onConnection}>
    <WorkspaceDestinations view="directories" workspace="workspace" viewer="me" onOpenChannel={()=>{}} onOpenMembers={()=>{}} onOpenAgents={()=>{}} />
    <ConversationMessage message={message as any} viewerId="me" />
  </ProfileProvider>);
  await waitFor(() => expect(screen.getAllByRole('button', {name:'View Ada’s profile'})).toHaveLength(3));
  const triggers = screen.getAllByRole('button', {name:'View Ada’s profile'});
  expect(triggers).toHaveLength(3);
  for (const trigger of triggers) {
    await userEvent.click(trigger); await screen.findByRole('heading', {name:'Ada Lovelace'});
    expect(screen.getAllByRole('region',{name:'Profile'})).toHaveLength(1);
    await userEvent.click(screen.getByRole('button',{name:'Close profile'}));
    await waitFor(() => expect(screen.queryByRole('region',{name:'Profile'})).toBeNull());
  }
});

it('does not navigate when a Message request finishes after closing the profile', async () => {
  let resolve!: (value:unknown) => void;
  mount(); await userEvent.click(screen.getByText('Open Ada')); await screen.findByRole('heading',{name:'Ada Lovelace'});
  api.request.mockImplementationOnce(() => new Promise(done => {resolve=done;}));
  await userEvent.click(screen.getByRole('button',{name:'Message Ada'}));
  await userEvent.click(screen.getByRole('button',{name:'Close profile'}));
  await act(async () => {resolve({id:'dm'});});
  expect(onMessage).not.toHaveBeenCalled();
});

it('prepares an agent mention without replacing an existing draft or duplicating a mention', async () => {
  const {profileMessageDraft} = await import('./profile-message.js');
  const draft = {ops:[{insert:'Unsent thoughts'}]};
  const result = profileMessageDraft(agent as any,draft);
  expect(result.ops[0]).toEqual(draft.ops[0]);
  expect(result.ops[2]?.attributes?.mention).toEqual({kind:'agent',id:'bot',label:'Codex'});
  expect(profileMessageDraft(agent as any,result)).toBe(result);
  expect(draft.ops).toEqual([{insert:'Unsent thoughts'}]);
});
