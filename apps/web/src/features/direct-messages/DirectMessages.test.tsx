import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DirectMessages, DirectMessagesPeek, NewDirectMessage } from './DirectMessages.js';
const mocks = vi.hoisted(() => ({ refresh: undefined as undefined | (() => unknown), counts: [{ channel_id: 'dm', unread_count: 2, latest_sequence: '2', last_read_sequence: '0' }] }));
vi.mock('../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: (_scope: string, _id: string, read: () => unknown) => { mocks.refresh = read; void read(); return () => {}; } }));
vi.mock('../notifications/useWorkspaceUnread.js', () => ({ useWorkspaceUnread: () => ({ channels: mocks.counts }) }));
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; }; });
const peer = { id: 'peer', name: 'Alex', image: null, title: 'Designer', presence: 'active' };
const dm = { id: 'dm', workspace_id: 'workspace', kind: 'direct', name: 'Alex', private: true, joined: true, participants: [peer], hidden: false, last_message: { text: 'Hello there', created_at: '2026-11-04T00:00:00Z', author_name: 'Alex' }, topic: '', description: '', created_by: 'user', created_at: '2026-11-04T00:00:00Z', archived_at: null };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mocks.refresh = undefined; mocks.counts = [{ channel_id: 'dm', unread_count: 2, latest_sequence: '2', last_read_sequence: '0' }]; });
function fetcher(handler: (path: string, options?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => { const result = handler(path, options); return { ok: true, status: 200, json: async () => result }; }));
}
describe('DM recipient selection', () => {
  it('searches people and opens the selected existing conversation exactly once', async () => {
    fetcher(path => path.includes('direct-message-people') ? { items: [peer], next_cursor: null } : dm);
    const opened = vi.fn(); render(<NewDirectMessage workspace="workspace" viewer="user" onOpen={opened} onClose={() => {}} />);
    const input = screen.getByRole('searchbox', { name: 'To' });
    await userEvent.type(input, 'Alex');
    await userEvent.click(await screen.findByRole('button', { name: /Alex Designer/ }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(dm, { ops: [] }));
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body).toBe(JSON.stringify({ user_id: 'peer' }));
  });
  it('keeps errors visible and allows retry without losing the search', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: !fail, status: fail ? 503 : 200, json: async () => fail ? { error: 'temporarily_unavailable' } : { items: [peer], next_cursor: null } })));
    render(<NewDirectMessage workspace="workspace" viewer="user" onOpen={() => {}} onClose={() => {}} />);
    await screen.findByRole('alert'); fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: /Alex Designer/ });
  });
});
it('renders an inbox, filters unread conversations, and opens the chosen DM', async () => {
  fetcher(() => ({ items: [dm, { ...dm, id: 'self', name: 'Kai (you)', last_message: null }], next_cursor: null }));
  const room = vi.fn((_dm: unknown) => <div>Conversation content</div>);
  render(<DirectMessages workspace="workspace" viewer="user" renderConversation={room} onVisit={() => {}} />);
  await screen.findByText('Hello there');
  await userEvent.click(screen.getByRole('switch', { name: 'Unreads' }));
  expect(screen.queryByRole('button', { name: /Open DM with Kai/ })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /Open DM with Alex/ }));
  await screen.findByText('Conversation content');
  expect(room.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'dm' });
});
it('hides a DM per user without deleting its history', async () => {
  let hidden = false;
  fetcher((path, init) => {
    if (init?.method === 'PATCH') { hidden = true; return { ...dm, hidden: true }; }
    return { items: hidden ? [] : [dm], next_cursor: null };
  });
  render(<DirectMessages workspace="workspace" viewer="user" renderConversation={(_dm, controls) => <button onClick={() => void controls.close()}>Close this DM</button>} onVisit={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: /Open DM with Alex/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Close this DM' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /Open DM with Alex/ })).toBeNull());
  const patch = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(patch?.[0]).toBe('/v1/channels/dm/direct-message'); expect(patch?.[1]?.body).toBe('{"hidden":true}');
});

it('keeps new-message drafting inline, focuses To, and retains it after closing', async () => {
  fetcher(path => ({ items: path.includes('direct-message-people') ? [peer] : [dm], next_cursor: null }));
  render(<DirectMessages workspace="workspace" viewer="user" onVisit={() => {}} renderConversation={() => <div>Room</div>} />);
  await screen.findByText('Hello there');
  await userEvent.click(screen.getAllByRole('button', { name: 'New message', exact: true })[0]!);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'To' }));
  const editor = await screen.findByRole('textbox', { name: 'Message new conversation' });
  await userEvent.type(editor, 'Unsent note');
  expect((screen.getByRole('button', { name: 'Send now' }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Close new message' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'New message', exact: true })[0]));
  await userEvent.click(screen.getAllByRole('button', { name: 'New message', exact: true })[0]!);
  expect((await screen.findByRole('textbox', { name: 'Message new conversation' })).textContent).toContain('Unsent note');
  expect(screen.getByText('Hello there')).toBeTruthy();
});
it('hands off the latest new-message draft while preserving an existing recipient draft', async () => {
  fetcher(path => path.includes('direct-message-people') ? { items: [peer] } : path.includes('direct-messages?') ? { items: [dm] } : dm);
  const drafts = { dm: { ops: [{ insert: 'Existing note\n', attributes: { bold: true } }] } };
  const changed = vi.fn((key, doc) => { Object.assign(drafts, { [key]: doc }); });
  render(<DirectMessages workspace="workspace" viewer="user" compose={1} drafts={drafts} onDraftChange={changed} onVisit={() => {}} renderConversation={() => <div>Opened room</div>} />);
  const editor = await screen.findByRole('textbox', { name: 'Message new conversation' });
  await userEvent.type(editor, 'New note');
  await userEvent.click(await screen.findByRole('button', { name: /Alex Designer/ }));
  await screen.findByText('Opened room');
  expect(drafts.dm.ops[0]).toEqual({ insert: 'Existing note\n', attributes: { bold: true } });
  expect(drafts.dm.ops.map(op => op.insert).join('')).toContain('New note');
  expect(changed).toHaveBeenCalledWith('new-direct:workspace', { ops: [] });
});
it('uses edits made while a recipient open is pending and prevents duplicate opens', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  fetcher((_path, options) => options?.method === 'POST' ? pending : { items: [peer] });
  const opened = vi.fn();
  render(<NewDirectMessage workspace="workspace" viewer="user" onOpen={opened} onClose={() => {}} />);
  const editor = await screen.findByRole('textbox', { name: 'Message new conversation' });
  const recipient = await screen.findByRole('button', { name: /Alex Designer/ });
  await userEvent.click(recipient);
  fireEvent.click(recipient);
  await userEvent.type(editor, 'Keep the latest edit');
  finish(dm);
  await waitFor(() => expect(opened).toHaveBeenCalledOnce());
  expect(opened.mock.calls[0]?.[1].ops.map((op: { insert: string }) => op.insert).join('')).toContain('Keep the latest edit');
  expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});

it('previews recent DMs, filters server-side and navigates only when a row is chosen', async () => {
  fetcher(path => ({ items: path.includes('unread=true') ? [] : [dm], next_cursor: null }));
  const open = vi.fn();
  const view = render(<DirectMessagesPeek workspace="workspace" viewer="user" onOpen={open} />);
  const row = await screen.findByRole('button', { name: /Open DM with Alex/ });
  expect(within(row).getByText('Alex: Hello there')).toBeTruthy();
  expect(row.querySelector('time')?.dateTime).toBe(dm.last_message.created_at);
  expect(open).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Unreads' }));
  await screen.findByText('No unread conversations.');
  await userEvent.click(screen.getByRole('button', { name: 'Unreads' }));
  await userEvent.click(await screen.findByRole('button', { name: /Open DM with Alex/ }));
  expect(open).toHaveBeenCalledWith('dm');
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  const signal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
