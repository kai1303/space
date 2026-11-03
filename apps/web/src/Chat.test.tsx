import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Chat } from './Chat.js';
import type { ChatMessage, MessagePage } from '@space/contracts';

it('renders live structured agent responses and replaces activity with one saved response', async () => {
  const root = paginatedMessage('Root message', '1');
  mockPaginatedChat(() => messagePage([root]), '1');
  render(<Chat />);
  await screen.findByText(root.text);
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  await within(screen.getByRole('region', { name: 'Thread', exact: true })).findByText(root.text);
  const socket = mocks.sockets.at(-1);
  const response = { messages: [{ id: 'm', text: '**Streaming result**', status: 'streaming' }], tools: [], components: [{ id: 'c', type: 'card', title: 'Churn analysis', body: 'Down 2%' }] };
  const activity = { channel_id: 'first', thread_id: 'thread', sequence: '2', occurred_at: root.created_at, type: 'task.event', payload: { task_id: 'task', type: 'execution.progress', actor_id: 'agent', installation_id: 'agent', owner_id: 'user', data: { text: 'Working', response } } };
  await act(async () => { socket.receive('chat.events', { channel_id: 'first', cursor: '2', events: [activity] }, vi.fn()); });
  expect((await screen.findByText('Streaming result')).tagName).toBe('STRONG');
  expect(screen.getByText('Down 2%')).toBeTruthy();
  const saved = { ...paginatedMessage('Final result', '3'), thread_root_id: root.id, reply_count: 1, task_id: 'task', text: '**Streaming result**', agent_response: { ...response, messages: [{ id: 'm', text: '**Streaming result**', status: 'complete' }] }, author: { kind: 'agent', id: 'agent', name: 'Research agent' } };
  await act(async () => { socket.receive('chat.events', { channel_id: 'first', cursor: '4', events: [
    { type: 'message.created', channel_id: 'first', thread_id: 'thread', sequence: '3', occurred_at: root.created_at, payload: saved },
    { ...activity, sequence: '4', payload: { ...activity.payload, type: 'task.completed', data: { result: saved.text, response: saved.agent_response } } },
  ] }, vi.fn()); });
  expect(screen.getAllByText('Streaming result')).toHaveLength(1);
  expect(screen.getAllByText('Down 2%')).toHaveLength(1);
  expect(within(screen.getByLabelText('Messages in first')).queryByText('Streaming result')).toBeNull();
});

it('clears revoked private drafts when channel discovery refreshes before socket revocation', async () => {
  let revoked = false;
  const privateChannel = { id: 'private', name: 'private', private: true, joined: true, workspace_id: 'workspace' };
  const publicChannel = { id: 'public', name: 'public', private: false, joined: true, workspace_id: 'workspace' };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path === '/v1/me') return { id: 'user', display_name: 'Kai' };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
    if (path.includes('/channels?')) return { items: revoked ? [publicChannel] : [privateChannel, publicChannel], next_cursor: null };
    if (isMessageHistory(path)) return messagePage();
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  render(<Chat />);
  await userEvent.type(await screen.findByRole('textbox', { name: 'Message private' }), 'Private draft before removal');
  revoked = true; fireEvent.focus(window);
  await screen.findByRole('textbox', { name: 'Message public' });
  expect(screen.queryByRole('button', { name: 'private', exact: true })).toBeNull();
  revoked = false; fireEvent.focus(window);
  await userEvent.click(await screen.findByRole('button', { name: 'private', exact: true }));
  expect((await screen.findByRole('textbox', { name: 'Message private' })).textContent).not.toContain('Private draft before removal');
});

function messagePage(messages: ChatMessage[] = [], overrides: Partial<MessagePage> = {}): MessagePage {
  return { messages, older_cursor: messages[0]?.sequence ?? null, newer_cursor: messages.at(-1)?.sequence ?? null, has_older: false, has_newer: false, event_cursor: messages.at(-1)?.sequence ?? '0', ...overrides };
}
const isMessageHistory = (path: string) => /\/channels\/[^/]+\/messages(?:\?|$)/.test(path) || /\/threads\/[^/]+\/history(?:\?|$)/.test(path);
// jsdom has no layout; exercise the timeline with every fixture row mounted.
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: (options: any) => {
  mocks.timelineRenders++;
  return {
  getTotalSize: () => options.count * 100 + 88,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 100 + 44 })),
  measureElement: () => {}, scrollToEnd: () => {}, scrollToIndex: () => {},
}; } }));
const mocks = vi.hoisted(() => ({ sockets: [] as any[], sessionId: 'session-a', refetch: vi.fn(), upload: vi.fn(), sendFailures: 0, pendingSend: undefined as undefined | Promise<void>, timelineRenders: 0 }));
vi.mock('./assets.js', () => ({ uploadAsset: mocks.upload }));
vi.mock('./auth-client.js', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'user', name: 'Kai' }, session: { id: mocks.sessionId } }, isPending: false, error: null, refetch: mocks.refetch }), signOut: vi.fn() } }));
vi.mock('socket.io-client', () => ({ io: () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const client = { connected: false, on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
    connect: () => { client.connected = true; handlers.get('connect')?.(); },
    disconnect: vi.fn(() => { client.connected = false; }),
    requests: [] as any[],
    timeout: () => ({ emitWithAck: async (name: string, data: any) => { client.requests.push({ name, data }); if (name === 'message.send' && mocks.pendingSend) await mocks.pendingSend; if (name === 'message.send' && mocks.sendFailures-- > 0) throw new Error('timed out'); return { data: name === 'message.send' ? { ...paginatedMessage(data.text, '1000', data.thread_id ?? data.client_message_id), id: data.client_message_id, client_message_id: data.client_message_id, document: data.document, thread_root_id: data.thread_id ? 'Send review root' : data.client_message_id } : data }; } }),
    receive: (name: string, ...args: any[]) => handlers.get(name)?.(...args),
  };
  mocks.sockets.push(client); return client;
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mocks.sockets.length = 0; mocks.upload.mockReset(); mocks.sendFailures = 0; mocks.pendingSend = undefined; });
beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    getClientRects: { configurable: true, value: () => [] },
  });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterAll(() => { Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect'); Reflect.deleteProperty(Range.prototype, 'getClientRects'); });
async function switchWorkspace(name: string) {
  await userEvent.click(screen.getByRole('button', { name: / Actions$/ }));
  await userEvent.click(screen.getByRole('menuitem', { name, exact: true }));
}
it('browses channel files outside loaded history, opens their source and keeps drafts across panels and revocation', async () => {
  let filesRevoked = false;
  let finishOlder!: (value: unknown) => void;
  const message = { id: 'loaded-message', channel_id: 'first', thread_id: 'thread', created_at: '2026-11-03T00:00:00Z', text: 'Loaded conversation', author: { kind: 'human', id: 'user', name: 'Kai' } };
  const file = { id: '11111111-1111-4111-8111-111111111111', name: 'older-report.pdf', type: 'application/pdf', size: 4096, preview_kind: 'pdf', message_id: 'older-source', thread_id: 'old-thread', shared_at: '2026-11-02T00:00:00Z', uploader: { id: 'user', name: 'Kai' } };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.includes('/first/assets?') && filesRevoked ? { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } : ({ ok: true, json: async () => {
    if (path === '/v1/me') return { id: 'user', display_name: 'Kai' };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
    if (path.includes('/channels?')) return { items: [{ id: 'first', name: 'first', workspace_id: 'workspace', joined: true }], next_cursor: null };
    if (path.includes('/first/messages?before=')) return new Promise(resolve => { finishOlder = resolve; });
    if (isMessageHistory(path)) return messagePage([{ ...message, sequence: '1' }], { has_older: !path.includes('/threads/') });
    if (path.includes('/first/assets?')) return { items: [file, { ...file, id: '22222222-2222-4222-8222-222222222222', name: 'loaded-image.png', preview_kind: 'image', message_id: message.id }], next_cursor: null };
    if (path.endsWith('/messages/older-source')) return { ...message, id: 'older-source', thread_id: 'old-thread', text: 'Original older file message' };
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  render(<Chat />);
  await screen.findByText('Loaded conversation');
  const draft = await screen.findByRole('textbox', { name: 'Message first' });
  await userEvent.type(draft, 'Keep this draft');
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('/first/assets?'))).toBe(false);
  const filesButton = screen.getByRole('button', { name: 'Files', exact: true });
  await userEvent.click(filesButton);
  const files = await screen.findByRole('region', { name: 'Files in #first' });
  await within(files).findByText('older-report.pdf');
  expect(filesButton.getAttribute('aria-expanded')).toBe('true');
  const listReads = vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('/first/assets?')).length;
  await act(async () => { mocks.sockets.at(-1).receive('chat.events', { channel_id: 'first', cursor: '2', events: [{ channel_id: 'first', thread_id: 'new-thread', sequence: '2', occurred_at: message.created_at, type: 'message.created', payload: { ...message, id: 'new-file-message', thread_id: 'new-thread', text: 'New file shared', attachments: [file], author: { kind: 'human', id: 'alex', name: 'Alex' } } }] }, vi.fn()); });
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('/first/assets?')).length).toBe(listReads + 1));
  await userEvent.click(within(files).getByRole('button', { name: 'View message for older-report.pdf' }));
  const source = await screen.findByRole('dialog', { name: 'Original message in #first' });
  await within(source).findByText('Original older file message');
  fireEvent(source, new Event('close'));
  await userEvent.click(within(files).getByRole('button', { name: 'View message for loaded-image.png' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Files in #first' })).toBeNull());
  await waitFor(() => expect(document.activeElement?.id).toBe('chat-message-loaded-message'));
  await userEvent.click(filesButton);
  await screen.findByRole('region', { name: 'Files in #first' });
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  await screen.findByRole('region', { name: 'Thread' });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Files in #first' })).toBeNull());
  await userEvent.click(filesButton);
  await screen.findByRole('region', { name: 'Files in #first' });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Thread' })).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Search in first' }));
  await screen.findByRole('dialog', { name: 'Search Space' });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Files in #first' })).toBeNull());
  const search = screen.getByRole('combobox', { name: 'Search messages' });
  await userEvent.clear(search); await userEvent.type(search, 'Loaded'); await userEvent.keyboard('{Enter}');
  await screen.findByLabelText('Search results');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search Space' })).toBeNull());
  await userEvent.click(filesButton);
  await screen.findByRole('region', { name: 'Files in #first' });
  await waitFor(() => expect(screen.queryByLabelText('Search results')).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Close files' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Files in #first' })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(filesButton));
  expect(draft.textContent).toContain('Keep this draft');
  await userEvent.click(screen.getByRole('button', { name: 'Load older history' }));
  await userEvent.click(filesButton);
  await screen.findByRole('button', { name: 'View message for older-report.pdf' });
  filesRevoked = true;
  await act(async () => { mocks.sockets.at(-1).receive('disconnect', 'transport close'); });
  await userEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Files in #first' })).toBeNull());
  expect(screen.queryByRole('button', { name: 'View message for older-report.pdf' })).toBeNull();
  expect(screen.queryByText('Loaded conversation')).toBeNull();
  expect(filesButton).toHaveProperty('disabled', true);
  await act(async () => { finishOlder(messagePage([{ ...message, sequence: '0', id: 'late-history', text: 'Late private history' }])); });
  expect(screen.queryByText('Late private history')).toBeNull();
});
it.each([false, true])('revalidates channel access when an older file source is unavailable: revoked=%s', async revoked => {
  let sourceRequested = false;
  const message = { id: 'loaded', channel_id: 'first', thread_id: 'thread', created_at: '2026-11-03T00:00:00Z', text: 'Cached channel message', author: { kind: 'human', id: 'user', name: 'Kai' } };
  const file = { id: '11111111-1111-4111-8111-111111111111', name: 'old.pdf', type: 'application/pdf', size: 4096, preview_kind: 'pdf', message_id: 'older-source', thread_id: 'old-thread', shared_at: message.created_at, uploader: { id: 'user', name: 'Kai' } };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/messages/older-source')) { sourceRequested = true; return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }; }
    if (path.includes('/first/assets?') && sourceRequested && revoked) return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    return { ok: true, json: async () => {
      if (path === '/v1/me') return { id: 'user', display_name: 'Kai' };
      if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
      if (path.includes('/channels?')) return { items: [{ id: 'first', name: 'first', workspace_id: 'workspace', joined: true }], next_cursor: null };
      if (isMessageHistory(path)) return messagePage([{ ...message, sequence: '1' }]);
      if (path.includes('/first/assets?')) return { items: [file], next_cursor: null };
      if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
    } };
  }));
  render(<Chat />);
  await screen.findByText('Cached channel message');
  await userEvent.click(screen.getByRole('button', { name: 'Files', exact: true }));
  await userEvent.click(await screen.findByRole('button', { name: 'View message for old.pdf' }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('/first/assets?'))).toHaveLength(2));
  if (revoked) {
    await waitFor(() => expect(screen.queryByText('Cached channel message')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Original message in #first' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Files', exact: true })).toHaveProperty('disabled', true);
  } else {
    expect(screen.getByText('Cached channel message')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Original message in #first' })).toBeTruthy();
  }
});
it('keeps the sidebar mounted and immediately restores the last channel while revalidating a workspace', async () => {
  let firstLoads = 0;
  let finishChannels!: (body: unknown) => void;
  const firstChannels = { items: ['first', 'second'].map(id => ({ id, name: id, workspace_id: 'a', joined: true })), next_cursor: null };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'a', name: 'Team A' }, { id: 'b', name: 'Team B' }], next_cursor: null };
    if (path.includes('/a/channels?')) return ++firstLoads === 1 ? firstChannels : new Promise(resolve => { finishChannels = resolve; });
    if (path.includes('/b/channels?')) return { items: [{ id: 'other', name: 'other', workspace_id: 'b', joined: true }], next_cursor: null };
    if (isMessageHistory(path)) {
      const id = path.split('/')[3]!;
      return messagePage([{ id, sequence: '1', channel_id: id, thread_id: id, created_at: '2026-11-03T00:00:00Z', text: `History ${id}`, author: { id: 'user', kind: 'human', name: 'Kai' } }]);
    }
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  const view = render(<Chat />);
  await screen.findByText('History first');
  await userEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  const composer = await screen.findByRole('textbox', { name: 'Message second' });
  await userEvent.type(composer, 'Keep this draft');
  const shell = view.container.querySelector('.chat-app');
  const sidebar = view.container.querySelector('.chat-sidebar');
  const filter = screen.getByRole('searchbox', { name: 'Find a conversation' });
  const oldSocket = mocks.sockets.at(-1);
  await userEvent.type(filter, 'second');
  await switchWorkspace('Team B');
  await screen.findByText('History other');
  expect(view.container.querySelector('.chat-app')).toBe(shell);
  expect(view.container.querySelector('.chat-sidebar')).toBe(sidebar);
  expect(screen.getByRole('searchbox', { name: 'Find a conversation' })).toBe(filter);
  expect((filter as HTMLInputElement).value).toBe('');
  expect(oldSocket.disconnect).toHaveBeenCalled();
  expect(screen.queryByText('History second')).toBeNull();
  await switchWorkspace('Team A');
  expect(screen.queryByRole('status', { name: 'Loading workspace' })).toBeNull();
  expect((filter as HTMLInputElement).value).toBe('second');
  expect(screen.getByRole('button', { name: 'second', exact: true }).getAttribute('aria-current')).toBe('page');
  expect((await screen.findByRole('textbox', { name: 'Message second' })).textContent).toContain('Keep this draft');
  expect(screen.queryByText('History other')).toBeNull();
  await act(async () => { finishChannels(firstChannels); });
  expect(screen.getByRole('textbox', { name: 'Message second' })).toBeTruthy();
  expect(view.container.querySelector('.chat-sidebar')).toBe(sidebar);
});
it.each(['forbidden', 'not_found'])('drops a cached workspace when revalidation denies access and ignores late workspace results: %s', async code => {
  let firstLoads = 0;
  let finishChannels!: (body: unknown) => void;
  let denyWorkspace!: (response: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.includes('/a/channels?') && ++firstLoads > 1) return new Promise(resolve => { denyWorkspace = resolve; });
    return { ok: true, json: async () => {
      if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'a', name: 'Team A' }, { id: 'b', name: 'Team B' }], next_cursor: null };
      if (path.includes('/a/channels?')) return { items: [{ id: 'first', name: 'first', workspace_id: 'a', joined: true }], next_cursor: null };
      if (path.includes('/b/channels?')) return new Promise(resolve => { finishChannels = resolve; });
      if (isMessageHistory(path)) return messagePage([{ id: 'private', sequence: '1', channel_id: 'first', thread_id: 'thread', created_at: '2026-11-03T00:00:00Z', text: 'Private history', author: { id: 'user', kind: 'human', name: 'Kai' } }]);
      if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
      return [];
    } };
  }));
  render(<Chat />);
  await screen.findByText('Private history');
  await switchWorkspace('Team B');
  expect(screen.queryByText('Private history')).toBeNull();
  await switchWorkspace('Team A');
  await screen.findByText('Private history');
  await act(async () => { finishChannels({ items: [{ id: 'other', name: 'other', workspace_id: 'b', joined: true }], next_cursor: null }); });
  expect(screen.queryByRole('button', { name: 'other', exact: true })).toBeNull();
  const socket = mocks.sockets.filter(s => s.requests.some((r: any) => r.name === 'channel.subscribe')).at(-1);
  await act(async () => { denyWorkspace({ ok: false, status: code === 'forbidden' ? 403 : 404, json: async () => ({ error: code }) }); });
  expect(screen.queryByText('Private history')).toBeNull();
  expect(screen.queryByRole('button', { name: 'first', exact: true })).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(code.replaceAll('_', ' '));
  expect(socket.disconnect).toHaveBeenCalled();
});
it.each([false, true])('keeps a pending channel creation scoped to its original workspace after switching: return=%s', async returnToOriginal => {
  let finishCreate!: (body: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => ({ ok: true, json: async () => {
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'a', name: 'Team A' }, { id: 'b', name: 'Team B' }], next_cursor: null };
    if (path === '/v1/workspaces/a/channels' && options?.method === 'POST') return new Promise(resolve => { finishCreate = resolve; });
    if (path.includes('/channels?')) return { items: [{ id: path.includes('/a/') ? 'first' : 'other', name: path.includes('/a/') ? 'first' : 'other', workspace_id: path.includes('/a/') ? 'a' : 'b', joined: false }], next_cursor: null };
    return [];
  } })));
  render(<Chat />);
  await screen.findByRole('button', { name: 'first', exact: true });
  await userEvent.click(screen.getByRole('button', { name: 'Add channel', exact: true }));
  const dialog = screen.getByRole('dialog', { name: 'Create a channel' });
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Channel name' }), 'late-channel');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create channel', exact: true }));
  // Switch through the persistent rail while the dialog's request is pending.
  await userEvent.click(screen.getByRole('button', { name: 'Switch workspaces… (Team A)' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Team B', exact: true }));
  await screen.findByRole('button', { name: 'Team B Actions' });
  if (returnToOriginal) await switchWorkspace('Team A');
  await act(async () => { finishCreate({ id: 'late', name: 'late-channel', workspace_id: 'a', joined: false }); });
  if (returnToOriginal) expect(screen.getByRole('button', { name: 'first', exact: true }).getAttribute('aria-current')).toBe('page');
  else expect(screen.queryByRole('button', { name: 'late-channel', exact: true })).toBeNull();
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a channel' })).toBeNull());
  expect(screen.getByRole('button', { name: `Search Team ${returnToOriginal ? 'A' : 'B'} ⌘ K` })).toHaveProperty('disabled', true);
});
it.each(['revalidation', 'refresh'])('does not let a stale %s undo a successful channel creation', async kind => {
  const first = { id: 'first', name: 'first', workspace_id: 'a', joined: false };
  const created = { id: 'created', name: 'created', workspace_id: 'a', joined: false };
  let deferList = false, posted = false;
  let finishList!: (body: unknown) => void, finishCreate!: (body: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => ({ ok: true, json: async () => {
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'a', name: 'Team A' }, { id: 'b', name: 'Team B' }], next_cursor: null };
    if (path === '/v1/workspaces/a/channels' && options?.method === 'POST') return new Promise(resolve => { finishCreate = resolve; });
    if (path.includes('/a/channels?')) return deferList ? new Promise(resolve => { finishList = resolve; }) : { items: posted ? [first, created] : [first], next_cursor: null };
    if (path.includes('/b/channels?')) return { items: [], next_cursor: null };
    return [];
  } })));
  render(<Chat />);
  await screen.findByRole('button', { name: 'first', exact: true });
  await switchWorkspace('Team B');
  await screen.findByRole('heading', { name: 'A place for every conversation' });
  deferList = kind === 'revalidation';
  await switchWorkspace('Team A');
  await userEvent.click(screen.getByRole('button', { name: 'Add channel', exact: true }));
  const dialog = screen.getByRole('dialog', { name: 'Create a channel' });
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Channel name' }), 'created');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create channel', exact: true }));
  if (kind === 'refresh') {
    deferList = true;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
  }
  posted = true;
  await act(async () => { finishCreate(created); });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a channel' })).toBeNull());
  expect(screen.getByRole('button', { name: 'created', exact: true }).getAttribute('aria-current')).toBe('page');
  deferList = false;
  await act(async () => { finishList({ items: [first], next_cursor: null }); });
  expect(screen.getByRole('button', { name: 'created', exact: true }).getAttribute('aria-current')).toBe('page');
});
it('shows loading instead of empty states and clears the old workspace before the next one is ready', async () => {
  let finishChannels!: (body: unknown) => void;
  let finishHistory!: (body: unknown) => void;
  const history = (id: string) => messagePage([{ id, sequence: '1', channel_id: id, thread_id: id, created_at: '2026-11-03T00:00:00Z', text: `History ${id}`, author: { kind: 'human', id: 'user', name: 'Kai' } }]);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'a', name: 'Team A' }, { id: 'b', name: 'Team B' }], next_cursor: null };
    if (path.includes('/a/channels?')) return { items: [{ id: 'first', name: 'first', workspace_id: 'a', joined: true }], next_cursor: null };
    if (path.includes('/b/channels?')) return new Promise(resolve => { finishChannels = resolve; });
    if (path.includes('/first/messages')) return history('first');
    if (path.includes('/second/messages')) return new Promise(resolve => { finishHistory = resolve; });
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  render(<Chat />);
  await screen.findByText('History first');
  const oldSocket = mocks.sockets.at(-1);
  await switchWorkspace('Team B');
  expect(screen.queryByText('History first')).toBeNull();
  expect(oldSocket.disconnect).toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'A place for every conversation' })).toBeNull();
  expect(screen.queryByText('No conversations found.')).toBeNull();
  expect(screen.getByRole('status', { name: 'Loading workspace' })).toBeTruthy();
  await act(async () => { finishChannels({ items: [{ id: 'second', name: 'second', workspace_id: 'b', joined: true }], next_cursor: null }); });
  expect(screen.getByRole('status', { name: 'Loading messages' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Opening #second' })).toBeNull();
  await act(async () => { finishHistory(history('second')); });
  const historyMessage = await screen.findByText('History second');
  expect(historyMessage.closest('article')?.style.opacity).toBe('1');
  expect(screen.queryByRole('status', { name: 'Loading messages' })).toBeNull();
  expect(screen.queryByText('History first')).toBeNull();
});
it('opens memory from message actions and follows source links to the authorized original message', async () => {
  const original = window.location.href;
  window.history.replaceState({}, '', '/chat?workspace=target&channel=source&message=source-message');
  const message = { id: 'source-message', channel_id: 'source', thread_id: 'thread', created_at: '2026-11-03T00:00:00Z', text: 'Original source decision', author: { kind: 'human', id: 'user', name: 'Kai' } };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path === '/v1/me') return { id: 'user', display_name: 'Kai' };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'other', name: 'Other team' }, { id: 'target', name: 'Target team' }], next_cursor: null };
    if (path.includes('/target/channels?')) return { items: [{ id: 'general', name: 'general', workspace_id: 'target', joined: true }, { id: 'source', name: 'source', workspace_id: 'target', joined: true }], next_cursor: null };
    if (path.includes('/other/channels?')) return { items: [], next_cursor: null };
    if (path.endsWith('/messages/source-message')) return message;
    if (path.endsWith('/memory/connections')) return { items: [] };
    if (path.endsWith('/memory/connections')) return { items: [] };
    if (path.endsWith('/memory')) return { enabled: false, provider: 'markdown', can_manage: true, providers: [{ id: 'markdown', name: 'Markdown files' }], document: null };
    if (isMessageHistory(path)) return messagePage([{ ...message, sequence: '1' }]);
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  try {
    render(<Chat />);
    const sourceDialog = await screen.findByRole('dialog', { name: 'Original message in #source' });
    expect(screen.getByRole('button', { name: 'Switch workspaces… (Target team)' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    // The native dialog stub does not emit close, so dispatch the browser event.
    fireEvent(sourceDialog, new Event('close'));
    await userEvent.click(screen.getByLabelText('More actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Save to channel memory' }));
    await screen.findByText('Memory is off for this channel.');
    expect(screen.getByRole('button', { name: 'Enable memory' })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('/source/memory'))).toBe(true);
  } finally { window.history.replaceState({}, '', original); }
});
it('isolates channel drafts and history, shows trusted agent authors, and clears history when access is revoked', async () => {
  const message = (channel: string, text: string) => ({ channel_id: channel, thread_id: 'thread', sequence: '1', occurred_at: '2026-11-03T00:00:00.000Z', type: 'message.created',
    payload: { id: channel, channel_id: channel, thread_id: 'thread', created_at: '2026-11-03T00:00:00.000Z', text, author: { kind: 'agent', name: 'Helper', id: 'agent' } } });
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    let body: unknown;
    if (path === '/v1/me') body = { id: 'user', display_name: 'Kai' };
    else if (path.startsWith('/v1/workspaces?')) body = { items: [{ id: 'workspace', name: 'Team' }, { id: 'another-workspace', name: 'Another team' }], next_cursor: null };
    else if (path.includes('/another-workspace/channels?')) body = { items: [], next_cursor: null };
    else if (path.includes('/channels?')) body = { items: [{ id: 'first', name: 'first', workspace_id: 'workspace', joined: true }, { id: 'second', name: 'second', workspace_id: 'workspace', joined: true }], next_cursor: null };
    else if (isMessageHistory(path)) body = messagePage([{ ...message(path.includes('/first/') ? 'first' : 'second', path.includes('/first/') ? 'First channel message' : 'Second channel message').payload, sequence: '1', author: { kind: 'agent', name: 'Helper', id: 'agent' } }]);
    else if (path.includes('/history')) body = { events: [], cursor: '1', has_more: false };
    else if (path.startsWith('/v1/agents/installations?')) body = [{ id: 'agent', connector_id: 'helper', enabled: true, capabilities: { skills: ['review'] } }];
    else if (path.endsWith('/navigator')) body = { candidates: [] };
    else body = [];
    return { ok: true, json: async () => body };
  }));
  const view = render(<Chat />);
  await screen.findByText('First channel message');
  const initialViewport = window.innerWidth;
  const resize = screen.getByRole('separator', { name: 'Sidebar width' });
  const initialWidth = Number(resize.getAttribute('aria-valuenow'));
  fireEvent.keyDown(resize, { key: 'ArrowRight' });
  const adjustedWidth = Number(resize.getAttribute('aria-valuenow'));
  expect(adjustedWidth).toBeGreaterThan(initialWidth);
  vi.stubGlobal('innerWidth', 895); fireEvent(window, new Event('resize'));
  expect(Number(resize.getAttribute('aria-valuenow'))).toBeLessThan(adjustedWidth);
  vi.stubGlobal('innerWidth', initialViewport); fireEvent(window, new Event('resize'));
  expect(Number(resize.getAttribute('aria-valuenow'))).toBe(adjustedWidth);
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await user.click(screen.getByLabelText('More actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Copy message' }));
  expect(clipboard).toHaveBeenCalledWith('First channel message');
  clipboard.mockRestore();
  expect(screen.getByRole('searchbox', { name: 'Find a conversation' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Search in first' })).toBeTruthy();
  expect(screen.getByText('APP')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'File uploads unavailable' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByLabelText('Development access token')).toBeNull();
  const options = vi.mocked(fetch).mock.calls[0]![1];
  expect(options?.credentials).toBe('same-origin');
  expect(options?.headers).not.toHaveProperty('authorization');
  const draft = await screen.findByRole('textbox', { name: 'Message first' });
  expect(screen.getByRole('toolbar', { name: 'Message formatting' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Code block', exact: true })).toBeTruthy();
  await userEvent.type(draft, 'Private draft');
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Helper' }));
  await userEvent.type(await screen.findByRole('textbox', { name: 'Message thread' }), 'Thread draft');
  const ask = screen.getByRole('button', { name: 'Ask an agent', exact: true });
  await userEvent.click(ask);
  const goal = await screen.findByRole('textbox', { name: 'What should the agent do?' });
  await userEvent.type(goal, 'Review this draft');
  await userEvent.click(ask);
  expect(screen.queryByRole('textbox', { name: 'What should the agent do?' })).toBeNull();
  await waitFor(() => expect(goal.isConnected).toBe(false));
  await userEvent.click(ask);
  expect((await screen.findByRole('textbox', { name: 'What should the agent do?' }) as HTMLTextAreaElement).value).toBe('Review this draft');
  fireEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  await screen.findByText('Second channel message');
  await userEvent.click(screen.getByRole('button', { name: 'Back in history' }));
  await screen.findByText('First channel message');
  expect((screen.getByRole('button', { name: 'Search Team ⌘ K' }) as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Forward in history' }));
  await screen.findByText('Second channel message');
  expect(screen.queryByText('First channel message')).toBeNull();
  expect((await screen.findByRole('textbox', { name: 'Message second' })).textContent?.trim()).toBe('');
  expect(mocks.sockets.find(s => s.requests.some((r: any) => r.name === 'channel.subscribe' && r.data.channel_id === 'first')).disconnect).toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'first', exact: true }));
  expect((await screen.findByRole('textbox', { name: 'Message first' })).textContent).toContain('Private draft');
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Helper' }));
  expect((await screen.findByRole('textbox', { name: 'Message thread' })).textContent).toContain('Thread draft');
  await userEvent.click(screen.getByRole('button', { name: 'New message', exact: true }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close thread' })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message first' })));
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Helper' }));
  expect((await screen.findByRole('textbox', { name: 'Message thread' })).textContent).toContain('Thread draft');
  await userEvent.click(screen.getByRole('button', { name: 'Search in first' }));
  expect(screen.getByText('Search loaded messages in #first. Load older history to include earlier messages.')).toBeTruthy();
  const search = screen.getByRole('combobox', { name: 'Search messages' });
  fireEvent.change(search, { target: { value: 'First channel message' } });
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  fireEvent.keyDown(search, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close thread' })).toBeNull());
  await switchWorkspace('Another team');
  await screen.findByRole('heading', { name: 'A place for every conversation' });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Switch workspaces… (Another team)' })));
  expect((screen.getByRole('button', { name: 'Search Another team ⌘ K' }) as HTMLButtonElement).disabled).toBe(true);
  await switchWorkspace('Team');
  expect((await screen.findByRole('textbox', { name: 'Message first' })).textContent).toContain('Private draft');
  await userEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  await screen.findByText('Second channel message');
  const current = mocks.sockets.at(-1);
  act(() => { current.receive('chat.events', { channel_id: 'second', events: [{ ...message('second', 'Live replay'), sequence: '2', payload: { ...message('second', 'Live replay').payload, id: 'new-message' } }], cursor: '2' }, () => {}); });
  act(() => { current.receive('chat.error', { error: 'ack_timeout' }); current.connected = false; current.receive('disconnect', 'io server disconnect'); });
  expect(screen.getByText('Second channel message')).toBeTruthy();
  await waitFor(() => expect(current.requests.filter((r: any) => r.name === 'channel.subscribe')).toHaveLength(2));
  expect(current.requests.at(-1).data.after).toBe('2');
  act(() => { current.receive('chat.events', { channel_id: 'second', events: [{ channel_id: 'second', thread_id: 'thread', sequence: '3', occurred_at: '2026-11-03T00:01:00.000Z', type: 'task.event', payload: { task_id: 'task', type: 'task.proposed', owner_id: 'user', actor_id: 'user', installation_id: 'agent', data: { goal: 'Review this update' } } }], cursor: '3' }, () => {}); });
  await userEvent.click(screen.getAllByRole('button', { name: 'Reply to Helper' })[0]!);
  await userEvent.click(await screen.findByRole('button', { name: 'Approve task', exact: true }));
  await screen.findByText('Approved', { exact: true });
  expect(vi.mocked(fetch).mock.calls.some(([path, options]) => path === '/v1/tasks/task/approve' && options?.method === 'POST')).toBe(true);
  expect(document.querySelector('.chat-thread')).toBeTruthy();
  act(() => { current.receive('chat.error', { error: 'not_found' }); });
  expect(document.querySelector('.chat-thread')).toBeNull();
  await waitFor(() => expect(screen.queryByText('Second channel message')).toBeNull());
  expect(screen.getByRole('alert').textContent).toContain('not found');
  act(() => { window.dispatchEvent(new Event('space:session-expired')); });
  expect(mocks.refetch).toHaveBeenCalled();
  mocks.sessionId = 'session-b';
  view.rerender(<Chat />);
  await screen.findByText('First channel message');
  expect(current.disconnect).toHaveBeenCalled();
  expect(mocks.sockets.at(-1)).not.toBe(current);
}, 15_000);

it('keeps the newest history destination when workspace loading overlaps repeated Back actions', async () => {
  let firstLoads = 0;
  let resolveChannels!: (value: unknown) => void;
  const firstChannels = { items: [{ id: 'first', name: 'first', workspace_id: 'a', joined: true }, { id: 'second', name: 'second', workspace_id: 'a', joined: true }], next_cursor: null };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.startsWith('/v1/workspaces?')) return { ok: true, json: async () => ({ items: [{ id: 'a', name: 'Team A' }, { id: 'b', name: 'Team B' }], next_cursor: null }) };
    if (path.includes('/a/channels?')) return { ok: true, json: async () => ++firstLoads === 1 ? firstChannels : new Promise(resolve => { resolveChannels = resolve; }) };
    if (path.includes('/b/channels?')) return { ok: true, json: async () => ({ items: [{ id: 'general', name: 'general', workspace_id: 'b', joined: true }], next_cursor: null }) };
    if (isMessageHistory(path)) {
      const id = path.split('/')[3]!;
      return { ok: true, json: async () => messagePage([{ id, sequence: '1', channel_id: id, thread_id: id, created_at: '2026-11-03T00:00:00Z', text: `History ${id}`, author: { id: 'user', kind: 'human', name: 'Kai' } }]) };
    }
    if (path.includes('/history')) return { ok: true, json: async () => ({ events: [], cursor: '0', has_more: false }) };
    return { ok: true, json: async () => [] };
  }));
  render(<Chat />);
  await screen.findByText('History first');
  await userEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  await screen.findByText('History second');
  await switchWorkspace('Team B'); await screen.findByText('History general');
  await userEvent.click(screen.getByRole('button', { name: 'Back in history' }));
  await waitFor(() => expect(resolveChannels).toBeTypeOf('function'));
  await userEvent.click(screen.getByRole('button', { name: 'Back in history' }));
  await act(async () => { resolveChannels(firstChannels); });
  await screen.findByText('History first');
  expect((screen.getByRole('button', { name: 'Forward in history' }) as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Forward in history' }));
  await screen.findByText('History second');
  await userEvent.click(screen.getByRole('button', { name: 'Forward in history' }));
  await screen.findByText('History general');
});

it('keeps uploads with their channel and thread drafts across navigation, retries failure and sends asset IDs', async () => {
  let finish!: (asset: any) => void;
  mocks.upload.mockImplementationOnce((_channel, _file, progress) => { progress(35); return new Promise(resolve => { finish = resolve; }); }).mockRejectedValueOnce(new Error('Storage unavailable')).mockResolvedValue({ id: 'thread-asset', name: 'thread.txt', size: 4, type: 'text/plain' });
  const attachment = { id: 'saved-asset', name: 'download.html', size: 20, type: 'text/html' };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path === '/v1/assets/config') return { enabled: true, max_file_size: 26214400, max_files: 5 };
    if (path === '/v1/assets/saved-asset/preview') return { kind: 'text', text: '<script>alert(1)</script>', language: 'html', truncated: false };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }, { id: 'other', name: 'Other team' }], next_cursor: null };
    if (path.includes('/other/channels?')) return { items: [], next_cursor: null };
    if (path.includes('/channels?')) return { items: [{ id: 'first', name: 'first', workspace_id: 'workspace', joined: true }, { id: 'second', name: 'second', workspace_id: 'workspace', joined: true }], next_cursor: null };
    if (isMessageHistory(path)) return messagePage([{ id: 'message', sequence: '1', channel_id: 'first', thread_id: 'thread', created_at: '2026-11-03T00:00:00Z', text: 'Attached', author: { kind: 'human', name: 'Kai', id: 'user' }, attachments: [attachment] }]);
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  const view = render(<Chat />);
  await screen.findByRole('textbox', { name: 'Message first' });
  expect(screen.getByRole('link', { name: /download.html/ }).getAttribute('href')).toBe('/v1/assets/saved-asset/download');
  expect(view.container.querySelector('iframe, img[src*="asset"], object')).toBeNull();
  expect(await screen.findByRole('button', { name: 'Preview download.html' })).toBeTruthy();
  expect(await screen.findByText('<script>alert(1)</script>')).toBeTruthy();
  expect(view.container.querySelector('script')).toBeNull();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(false));
  const report = new File(['data'], 'report.txt', { type: 'text/plain' });
  fireEvent.change(view.container.querySelector('#chat-messages input[type="file"]')!, { target: { files: [report] } });
  expect(mocks.upload.mock.calls[0].slice(0, 2)).toEqual(['first', report]);
  await screen.findByRole('progressbar', { name: 'Uploading report.txt' });
  await userEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  await screen.findByRole('textbox', { name: 'Message second' });
  expect(screen.queryByText('report.txt')).toBeNull();
  await act(async () => { finish({ id: 'report-asset', name: report.name, size: report.size, type: report.type }); });
  await switchWorkspace('Other team');
  await screen.findByRole('heading', { name: 'A place for every conversation' });
  await switchWorkspace('Team');
  await userEvent.click(await screen.findByRole('button', { name: 'first', exact: true }));
  await screen.findByRole('textbox', { name: 'Message first' });
  expect(screen.getByText('report.txt')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  await screen.findByRole('textbox', { name: 'Message thread' });
  expect(screen.getAllByRole('link', { name: /download.html/ })).toHaveLength(2);
  fireEvent.change(view.container.querySelector('.chat-thread input[type="file"]')!, { target: { files: [new File(['data'], 'thread.txt', { type: 'text/plain' })] } });
  await screen.findByRole('button', { name: 'Retry upload thread.txt' });
  await userEvent.click(screen.getByRole('button', { name: 'Close thread' }));
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Retry upload thread.txt' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry upload thread.txt' })).toBeNull());
  const buttons = screen.getAllByRole('button', { name: 'Send now' });
  await userEvent.click(buttons[1]!);
  await waitFor(() => expect(mocks.sockets.at(-1).requests.some((r: any) => r.name === 'message.send' && r.data.thread_id === 'thread' && r.data.asset_ids[0] === 'thread-asset')).toBe(true));
  mocks.sendFailures = 1;
  await userEvent.click(buttons[0]!);
  await screen.findByText('Could not send. Your draft is still here. Try again.');
  expect(screen.getByText('report.txt')).toBeTruthy();
  const firstReportAttempt = mocks.sockets.at(-1).requests.filter((r: any) => r.name === 'message.send' && !r.data.thread_id)[0];
  await userEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  await screen.findByRole('textbox', { name: 'Message second' });
  await userEvent.click(screen.getByRole('button', { name: 'first', exact: true }));
  await screen.findByRole('textbox', { name: 'Message first' });
  await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
  const reportAttempts = [firstReportAttempt, ...mocks.sockets.at(-1).requests.filter((r: any) => r.name === 'message.send' && !r.data.thread_id)];
  expect(reportAttempts).toHaveLength(2);
  expect(reportAttempts[1].data.client_message_id).toBe(reportAttempts[0].data.client_message_id);
  await waitFor(() => expect(mocks.sockets.at(-1).requests.some((r: any) => r.name === 'message.send' && !r.data.thread_id && r.data.asset_ids[0] === 'report-asset')).toBe(true));
  expect(mocks.upload).toHaveBeenCalledTimes(3);
  expect(screen.queryByText('report.txt')).toBeNull();
}, 15_000);
it('cancels removed files and clears attachment drafts on authorization loss and session changes', async () => {
  const jobs: { signal: AbortSignal; finish: (asset: any) => void }[] = [];
  mocks.upload.mockImplementation((_channel, _file, _progress, signal) => new Promise(resolve => { jobs.push({ signal, finish: resolve }); }));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path === '/v1/assets/config') return { enabled: true, max_file_size: 26214400, max_files: 5 };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
    if (path.includes('/channels?')) return { items: [{ id: 'first', name: 'first', workspace_id: 'workspace', joined: true }], next_cursor: null };
    if (isMessageHistory(path)) return messagePage();
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  const view = render(<Chat />);
  await screen.findByRole('textbox', { name: 'Message first' });
  const input = view.container.querySelector('input[type="file"]')!;
  const file = new File(['bytes'], 'private.txt');
  fireEvent.change(input, { target: { files: [file] } });
  await userEvent.click(screen.getByRole('button', { name: 'Remove private.txt' }));
  expect(jobs[0]!.signal.aborted).toBe(true);
  await act(async () => { jobs[0]!.finish({ id: 'removed-asset', name: file.name, size: file.size, type: file.type }); });
  expect(screen.queryByText('private.txt')).toBeNull();
  fireEvent.change(input, { target: { files: [file] } });
  act(() => mocks.sockets.at(-1).receive('chat.error', { error: 'not_found' }));
  expect(jobs[1]!.signal.aborted).toBe(true);
  await act(async () => { jobs[1]!.finish({ id: 'revoked-asset', name: file.name, size: file.size, type: file.type }); });
  mocks.sessionId = 'new-upload-session';
  view.rerender(<Chat />);
  await screen.findByRole('textbox', { name: 'Message first' });
  expect(screen.queryByText('private.txt')).toBeNull();
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  expect(jobs).toHaveLength(3);
  mocks.sessionId = 'another-upload-session';
  view.rerender(<Chat />);
  expect(jobs[2]!.signal.aborted).toBe(true);
  await act(async () => { jobs[2]!.finish({ id: 'old-session-asset', name: file.name, size: file.size, type: file.type }); });
  await screen.findByRole('textbox', { name: 'Message first' });
  expect(screen.queryByText('private.txt')).toBeNull();
});

it.each([false,true].flatMap(attached => [{edited:true,text:'Original draft'},{edited:false,text:'Original draft'},{edited:true,text:'Original :tada: draft'},{edited:false,text:'Original :tada: draft'}].map(test => ({...test,attached}))))('clears acknowledged drafts after navigation while preserving newer edits: %o', async ({edited,text,attached}) => {
  let acknowledge!: () => void;
  mocks.pendingSend = new Promise<void>(resolve => { acknowledge = resolve; });
  mocks.upload.mockResolvedValue({ id: 'sent-asset', name: 'sent.txt', size: 4, type: 'text/plain' });
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path === '/v1/assets/config') return { enabled: true, max_file_size: 26214400, max_files: 5 };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
    if (path.includes('/channels?')) return { items: [{ id: 'first', name: 'first', workspace_id: 'workspace', joined: true }, { id: 'second', name: 'second', workspace_id: 'workspace', joined: true }], next_cursor: null };
    if (isMessageHistory(path)) return messagePage();
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  const view = render(<Chat />);
  await userEvent.type(await screen.findByRole('textbox', { name: 'Message first' }), text);
  if (attached) fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['data'], 'sent.txt')] } });
  await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await userEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  await screen.findByRole('textbox', { name: 'Message second' });
  await userEvent.click(screen.getByRole('button', { name: 'first', exact: true }));
  const newer = await screen.findByRole('textbox', { name: 'Message first' });
  if (edited) await userEvent.type(newer, ' with new text');
  await act(async () => { acknowledge(); await mocks.pendingSend; });
  await waitFor(() => expect(screen.queryByText('sent.txt')).toBeNull());
  if (edited) expect(newer.textContent).toContain('with new text');
  else {
    await waitFor(() => expect(newer.textContent?.trim()).toBe(''));
    expect((screen.getByRole('button', { name: 'Send now' }) as HTMLButtonElement).disabled).toBe(true);
  }
});

it('creates a workspace directly from onboarding and opens the returned workspace', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => ({ ok: true, json: async () => {
    if (path === '/v1/workspaces' && options?.method === 'POST') return { id: 'created', name: 'Space studio', role: 'owner' };
    if (path.startsWith('/v1/workspaces?')) return { items: [], next_cursor: null };
    if (path.includes('/created/channels?')) return { items: [], next_cursor: null };
    return {};
  } })));
  render(<Chat />);
  await userEvent.type(await screen.findByRole('textbox', { name: 'Workspace name' }), 'Space studio');
  await userEvent.click(screen.getByRole('button', { name: 'Create workspace', exact: true }));
  await screen.findByRole('button', { name: 'Switch workspaces… (Space studio)' });
  expect(vi.mocked(fetch).mock.calls.some(([path, options]) => path === '/v1/workspaces' && options?.method === 'POST' && options.body === JSON.stringify({ name: 'Space studio' }))).toBe(true);
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('/organizations'))).toBe(false);
  expect(screen.queryByText(/organization/i)).toBeNull();
});

function paginatedMessage(id: string, sequence: string, thread = 'thread'): ChatMessage {
  return { id, sequence, channel_id: 'first', thread_id: thread, created_at: '2026-11-03T00:00:00Z', text: id, author: { kind: 'human', id: 'user', name: 'Kai' } };
}
function mockPaginatedChat(history: (path: string) => MessagePage | Promise<MessagePage>, replayCursor = '999') {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path === '/v1/me') return { id: 'user', display_name: 'Kai' };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
    if (path.includes('/channels?')) return { items: [{ id: 'first', name: 'first', workspace_id: 'workspace', joined: true }], next_cursor: null };
    if (isMessageHistory(path)) return history(path);
    if (path.includes('/history')) return { events: [], cursor: replayCursor, has_more: false };
    return [];
  } })));
}
function mockUnreadChat() {
  const root = { ...paginatedMessage('Unread hello', '1'), author: { kind: 'human' as const, id: 'other', name: 'Teammate' } };
  const snapshot = { workspace_id: 'workspace', channels: [
    { channel_id: 'first', last_read_sequence: '0', latest_sequence: '1', unread_count: 1 },
    { channel_id: 'second', last_read_sequence: '0', latest_sequence: '3', unread_count: 3 },
  ] };
  const fetch = vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path === '/v1/me') return { id: 'user', display_name: 'Kai' };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
    if (path.includes('/channels?')) return { items: ['first', 'second'].map(id => ({ id, name: id, workspace_id: 'workspace', joined: true })), next_cursor: null };
    if (path.endsWith('/unread')) return snapshot;
    if (isMessageHistory(path)) return messagePage([root]);
    if (path.includes('/history')) return { events: [], cursor: '1', has_more: false };
    return [];
  } }));
  vi.stubGlobal('fetch', fetch);
  return { fetch, snapshot };
}
it('updates unopened channel badges from authoritative realtime snapshots without double counting', async () => {
  const { snapshot } = mockUnreadChat();
  render(<Chat />);
  await waitFor(() => expect(mocks.sockets.some(s => s.requests.some((r: any) => r.name === 'workspace.subscribe'))).toBe(true));
  const socket = mocks.sockets.find(s => s.requests.some((r: any) => r.name === 'workspace.subscribe'));
  await act(async () => { socket.receive('workspace.unread', snapshot, vi.fn()); });
  await screen.findByLabelText('3 unread');
  const updated = { ...snapshot, channels: snapshot.channels.map(c => c.channel_id === 'second' ? { ...c, unread_count: 4, latest_sequence: '4' } : c) };
  await act(async () => { socket.receive('workspace.unread', updated, vi.fn()); socket.receive('workspace.unread', updated, vi.fn()); });
  expect(screen.getAllByLabelText('4 unread')).toHaveLength(1);
  expect(screen.queryByLabelText('3 unread')).toBeNull();
  await act(async () => { socket.receive('workspace.unread', { workspace_id: 'elsewhere', channels: [] }, vi.fn()); });
  expect(screen.getByLabelText('4 unread')).toBeTruthy();
});
it('marks only the visible latest messages read in a focused window and preserves the new-message divider', async () => {
  let focused = false;
  const focus = vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  const { fetch, snapshot } = mockUnreadChat();
  const reads = () => fetch.mock.calls.filter(([path]) => path === '/v1/channels/first/read');
  try {
    render(<Chat />);
    await screen.findByText('Unread hello');
    const socket = mocks.sockets.find(s => s.requests.some((r: any) => r.name === 'workspace.subscribe'));
    await act(async () => { socket.receive('workspace.unread', snapshot, vi.fn()); });
    await screen.findByText('New messages');
    expect(reads()).toHaveLength(0);
    const timeline = screen.getByLabelText('Messages in first');
    Object.defineProperties(timeline, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
    fireEvent.scroll(timeline, { target: { scrollTop: 0 } });
    focused = true; fireEvent.focus(window);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(reads()).toHaveLength(0);
    fireEvent.scroll(timeline, { target: { scrollTop: 900 } });
    await waitFor(() => expect(reads()).toHaveLength(1));
    const options = (fetch.mock.calls as unknown as [string, RequestInit][]).find(([path]) => path.endsWith('/first/read'))![1];
    expect(JSON.parse(options.body as string)).toEqual({ sequence: '1' });
    expect(screen.getByText('New messages')).toBeTruthy();
  } finally { focus.mockRestore(); }
});
it('keeps typing local to the mounted composer without rendering message history', async () => {
  mockPaginatedChat(() => messagePage([paginatedMessage('Saved conversation', '1')]));
  render(<Chat />);
  await screen.findByText('Saved conversation');
  const editor = await screen.findByRole('textbox', { name: 'Message first' });
  await userEvent.click(editor);
  await act(async () => {});
  const renders = mocks.timelineRenders;
  await userEvent.type(editor, 'Keep this draft while typing', { skipClick: true });
  expect(editor.textContent).toContain('Keep this draft while typing');
  expect(mocks.timelineRenders).toBe(renders);
  expect(screen.getByRole('textbox', { name: 'Message first' })).toBe(editor);
  expect(document.activeElement).toBe(editor);
});
it('loads older channel messages near the top once and deduplicates overlapping pages and live replay', async () => {
  const latest = paginatedMessage('Latest channel message', '20');
  let finishOlder!: (page: MessagePage) => void;
  mockPaginatedChat(path => path.includes('?before=20')
    ? new Promise(resolve => { finishOlder = resolve; })
    : messagePage([latest], { has_older: true, event_cursor: '25' }));
  render(<Chat />);
  await screen.findByText(latest.text);
  const socket = mocks.sockets.at(-1);
  expect(socket.requests.find((request: any) => request.name === 'channel.subscribe').data.after).toBe('25');
  const timeline = screen.getByLabelText('Messages in first');
  Object.defineProperties(timeline, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 600 } });
  fireEvent.scroll(timeline, { target: { scrollTop: 700 } });
  expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('?before='))).toHaveLength(0);
  fireEvent.scroll(timeline, { target: { scrollTop: 250 } });
  await waitFor(() => expect(finishOlder).toBeTypeOf('function'));
  fireEvent.scroll(timeline, { target: { scrollTop: 150 } });
  expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('?before='))).toHaveLength(1);
  const older = paginatedMessage('Older channel message', '10');
  await act(async () => { finishOlder(messagePage([older, latest], { event_cursor: '25' })); });
  await screen.findByText(older.text);
  expect(screen.getAllByText(latest.text)).toHaveLength(1);
  const replay = { channel_id: 'first', cursor: '25', events: [older, latest].map(payload => ({ channel_id: 'first', thread_id: payload.thread_id, sequence: payload.sequence, occurred_at: payload.created_at, type: 'message.created', payload })) };
  const ack = vi.fn();
  await act(async () => { socket.receive('chat.events', replay, ack); socket.receive('chat.events', replay, ack); });
  expect(ack).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText(older.text)).toHaveLength(1);
  expect(screen.getAllByText(latest.text)).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Load older history' })).toBeNull();
});
it('paginates thread history with its own cursor without expanding the channel window', async () => {
  const channelMessage = paginatedMessage('Channel window message', '80');
  const reply = paginatedMessage('Independent thread reply', '30');
  const olderReply = paginatedMessage('Older thread reply', '10');
  mockPaginatedChat(path => path.includes('/threads/')
    ? path.includes('?before=30') ? messagePage([olderReply], { event_cursor: '100' }) : messagePage([reply], { has_older: true, event_cursor: '100' })
    : messagePage([channelMessage], { has_older: true, event_cursor: '100' }));
  render(<Chat />);
  await screen.findByText(channelMessage.text);
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  const thread = await screen.findByRole('region', { name: 'Thread' });
  await within(thread).findByText(reply.text);
  const timeline = within(thread).getByLabelText('Thread messages');
  fireEvent.scroll(timeline, { target: { scrollTop: 600 } });
  fireEvent.scroll(timeline, { target: { scrollTop: 200 } });
  await within(thread).findByText(olderReply.text);
  expect(vi.mocked(fetch).mock.calls.some(([path]) => path === '/v1/threads/thread/history?before=30')).toBe(true);
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('/first/messages?before='))).toBe(false);
  expect(within(screen.getByLabelText('Messages in first')).queryByText(olderReply.text)).toBeNull();
  expect(within(thread).getByText(reply.text)).toBeTruthy();
});
it.each(['forbidden', 'not_found'])('clears both history windows when thread pagination loses access: %s', async error => {
  const channelMessage = paginatedMessage('Private channel message', '80');
  const reply = paginatedMessage('Private thread reply', '30');
  let finishOlder!: (page: MessagePage) => void;
  mockPaginatedChat(path => path.includes('/threads/')
    ? messagePage([reply], { has_older: true, event_cursor: '100' })
    : path.includes('?before=80') ? new Promise(resolve => { finishOlder = resolve; }) : messagePage([channelMessage], { has_older: true, event_cursor: '100' }));
  const initialFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => String(args[0]).includes('/threads/thread/history?before=30')
    ? { ok: false, status: error === 'forbidden' ? 403 : 404, json: async () => ({ error }) } as Response
    : initialFetch(...args));
  render(<Chat />);
  await screen.findByText(channelMessage.text);
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  const thread = await screen.findByRole('region', { name: 'Thread' });
  await within(thread).findByText(reply.text);
  await userEvent.click(within(screen.getByLabelText('Messages in first')).getByRole('button', { name: 'Load older history' }));
  await waitFor(() => expect(finishOlder).toBeTypeOf('function'));
  await userEvent.click(within(thread).getByRole('button', { name: 'Load older history' }));
  await waitFor(() => expect(screen.queryByText(channelMessage.text)).toBeNull());
  expect(screen.queryByRole('region', { name: 'Thread' })).toBeNull();
  expect(mocks.sockets.at(-1).disconnect).toHaveBeenCalled();
  await act(async () => { finishOlder(messagePage([paginatedMessage('Late revoked history', '10')])); });
  expect(screen.queryByText('Late revoked history')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Message first' })).toBeNull();
});

it('replays from the earlier snapshot watermark so tasks between history reads are delivered', async () => {
  const message = paginatedMessage('Snapshot message', '90');
  mockPaginatedChat(() => messagePage([message], { event_cursor: '100' }), '99');
  render(<Chat />);
  await screen.findByText(message.text);
  const socket = mocks.sockets.at(-1);
  expect(socket.requests.find((request: any) => request.name === 'channel.subscribe').data.after).toBe('99');
  await act(async () => { socket.receive('chat.events', { channel_id: 'first', cursor: '100', events: [{
    channel_id: 'first', thread_id: 'thread', sequence: '100', occurred_at: message.created_at, type: 'task.event',
    payload: { task_id: 'between-snapshots', type: 'task.proposed', owner_id: 'user', actor_id: 'user', installation_id: 'agent', data: { goal: 'Task created between snapshot reads' } },
  }] }, vi.fn()); });
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  expect(await screen.findByText('Task created between snapshot reads')).toBeTruthy();
  expect(within(screen.getByLabelText('Messages in first')).getAllByText(message.text)).toHaveLength(1);
});

it('retries a failed initial message request and connects after both snapshots recover', async () => {
  const message = paginatedMessage('Recovered channel message', '90');
  mockPaginatedChat(() => messagePage([message], { event_cursor: '100' }), '99');
  const initialFetch = vi.mocked(fetch).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (args[0] === '/v1/channels/first/messages' && attempts++ === 0) throw new TypeError('Failed to fetch');
    return initialFetch(...args);
  });
  render(<Chat />);
  const retry = await screen.findByRole('button', { name: 'Retry loading messages' });
  const firstSocket = mocks.sockets.at(-1);
  expect(firstSocket.connected).toBe(false);
  expect(firstSocket.requests.some((request: any) => request.name === 'channel.subscribe')).toBe(false);
  await userEvent.click(retry);
  await screen.findByText(message.text);
  await waitFor(() => expect(mocks.sockets.at(-1).connected).toBe(true));
  expect(attempts).toBe(2);
  expect(vi.mocked(fetch).mock.calls.filter(([path]) => path === '/v1/channels/first/history')).toHaveLength(2);
  expect(firstSocket.disconnect).toHaveBeenCalled();
  const recoveredSocket = mocks.sockets.at(-1);
  expect(recoveredSocket).not.toBe(firstSocket);
  expect(recoveredSocket.connected).toBe(true);
  expect(recoveredSocket.requests.find((request: any) => request.name === 'channel.subscribe').data.after).toBe('99');
  expect(screen.queryByRole('button', { name: 'Retry loading messages' })).toBeNull();
  expect(screen.queryByRole('status', { name: 'Loading messages' })).toBeNull();
});

it('retries a transient handshake failure without clearing the draft or accepted history', async () => {
  mockPaginatedChat(() => messagePage([paginatedMessage('Saved conversation', '42')]));
  render(<Chat />);
  await screen.findByText('Saved conversation');
  const editor = await screen.findByRole('textbox', { name: 'Message first' });
  await userEvent.type(editor, 'Keep my unsent work');
  const socket = mocks.sockets.at(-1);
  act(() => { socket.connected = false; socket.receive('connect_error', new Error('internal_error')); });
  await waitFor(() => expect(socket.requests.filter((request: any) => request.name === 'channel.subscribe')).toHaveLength(2));
  expect(editor.textContent).toContain('Keep my unsent work');
  expect(screen.getByText('Saved conversation')).toBeTruthy();
  expect(socket.requests.at(-1).data.after).toBe('42');
});

it('opens the agent workspace from a task, restores focus, and clears it after revocation', async () => {
  mockPaginatedChat(() => messagePage([paginatedMessage('Conversation with an agent task', '1')]));
  const original = vi.mocked(fetch).getMockImplementation()!;
  const task = { id: 'workspace-task', workspace_id: 'workspace', thread_id: 'thread', installation_id: 'agent', goal: 'Build the result viewer', skill: 'demo.echo', requester_id: 'user', approved_by: 'user', status: 'completed', session_id: 'session', active_execution_id: 'execution', revision: 4, result: 'The result is saved.' };
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (String(args[0]).startsWith('/v1/tasks/workspace-task')) return { ok: true, json: async () => String(args[0]).includes('/events') ? [] : task } as Response;
    return original(...args);
  });
  render(<Chat />);
  await screen.findByText('Conversation with an agent task');
  const socket = mocks.sockets.at(-1);
  await act(async () => { socket.receive('chat.events', { channel_id: 'first', cursor: '2', events: [{
    channel_id: 'first', thread_id: 'thread', sequence: '2', occurred_at: '2026-11-03T08:00:00.000Z', type: 'task.event',
    payload: { task_id: task.id, type: 'task.completed', owner_id: 'user', actor_id: 'agent', installation_id: 'agent', data: { goal: task.goal, result: task.result } },
  }] }, vi.fn()); });
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  const open = await screen.findByRole('button', { name: 'Open workspace' });
  await userEvent.click(open);
  const workspace = await screen.findByRole('region', { name: 'Agent workspace' });
  await within(workspace).findByText('No preview attached');
  await userEvent.click(within(workspace).getByRole('button', { name: 'Close agent workspace' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Agent workspace' })).toBeNull());
  await waitFor(() => expect(document.activeElement?.id).toBe('chat-messages'));
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Open workspace' }));
  await screen.findByRole('region', { name: 'Agent workspace' });
  await act(async () => { socket.receive('chat.error', { error: 'not_found' }); });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Agent workspace' })).toBeNull());
  expect(screen.queryByText('Conversation with an agent task')).toBeNull();
});

it('keeps the workspace available on a saved structured agent response', async () => {
  const saved = { ...paginatedMessage('Saved agent result', '3'), task_id: 'saved-task', author: { kind: 'agent' as const, id: 'agent', name: 'Research agent' }, agent_response: { messages: [{ id: 'm', text: 'The report is ready.', status: 'complete' as const }], tools: [], components: [] } };
  mockPaginatedChat(() => messagePage([saved]));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (String(args[0]).startsWith('/v1/tasks/saved-task')) return { ok: true, json: async () => String(args[0]).includes('/events') ? [] : { id: 'saved-task', goal: 'Research the report', status: 'completed', result: 'Saved report result', skill: 'demo.echo' } } as Response;
    return original(...args);
  });
  render(<Chat />);
  await screen.findByText('The report is ready.');
  await userEvent.click(screen.getByRole('button', { name: 'Open workspace' }));
  await within(await screen.findByRole('region', { name: 'Agent workspace' })).findByText('No preview attached');
});

it('persists emoji reaction intent and applies realtime reaction updates to the same message', async () => {
  const root = paginatedMessage('React to this', '1');
  mockPaginatedChat(() => messagePage([root]), '1');
  const initialFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith(`/messages/${root.id}/reactions`)) return new Response(JSON.stringify({ ...root, reaction_sequence: '2', reactions: [{ emoji: '👀', count: 1, user_ids: ['user'] }] }), {status:200});
    return initialFetch(...args);
  });
  render(<Chat />);
  await screen.findByText(root.text);
  await userEvent.click(screen.getByRole('button',{name:'React with eyes'}));
  const chip = await screen.findByRole('button',{name:'👀 1 reactions'});
  expect(chip.getAttribute('aria-pressed')).toBe('true');
  expect(vi.mocked(fetch).mock.calls.some(([path, init]) => String(path).endsWith('/reactions') && JSON.parse(String(init?.body)).active === true)).toBe(true);
  const updated = {...root,reaction_sequence:'3',reactions:[{emoji:'👀',count:2,user_ids:['user','other']}]};
  await act(async () => { mocks.sockets.at(-1).receive('chat.events',{channel_id:'first',cursor:'3',events:[{type:'message.updated',channel_id:'first',thread_id:root.thread_id,sequence:'3',occurred_at:root.created_at,payload:updated}]},vi.fn()); });
  expect(await screen.findByRole('button',{name:'👀 2 reactions'})).toBeTruthy();
  expect(screen.getAllByText(root.text)).toHaveLength(1);
});
it('opens the current profile for a stored mention and sends selected mentions with their IDs',async()=>{
 const person={kind:'user' as const,id:'00000000-0000-4000-8000-000000000002',label:'Jamie Chen',detail:'Engineer',joined:true};
 const root={...paginatedMessage('@Jamie Chen hello','1'),document:{ops:[{insert:'@Jamie Chen',attributes:{mention:{kind:person.kind,id:person.id,label:person.label}}},{insert:' hello\n'}]}};
 mockPaginatedChat(()=>messagePage([root]),'1');
 const original=vi.mocked(fetch).getMockImplementation()!;
 vi.mocked(fetch).mockImplementation(async(...args)=>{
  const path=String(args[0]);
  if(path.includes('/mentions/user/'))return new Response(JSON.stringify({...person,label:'Jamie Updated'}),{status:200});
  if(path.includes('/mentions?q='))return new Response(JSON.stringify({items:[person],member_count:2}),{status:200});
  if(path.endsWith('/mention-settings'))return new Response(JSON.stringify({paused_until:null,broadcast_permission:'all',can_manage:false,member_count:2,general_channel_id:'first'}),{status:200});
  if(path.endsWith('/mentions'))return new Response(JSON.stringify({items:[],unread_count:0,next_cursor:null}),{status:200});
  return original(...args);
 });
 render(<Chat/>);
 await userEvent.click(await screen.findByRole('button',{name:'@Jamie Chen'}));
 const profile=await screen.findByRole('dialog',{name:'Jamie Updated'});
 await userEvent.click(within(profile).getByRole('button',{name:'Close dialog'}));
 const editor=await screen.findByRole('textbox',{name:'Message first'});
 await userEvent.type(editor,'@Ja');await screen.findByRole('option',{name:/Jamie Chen/});await userEvent.keyboard('{Enter}');
 await userEvent.keyboard('review{Enter}');
 await waitFor(()=>expect(mocks.sockets.at(-1).requests.some((r:any)=>r.name==='message.send'&&r.data.document.ops.some((op:any)=>op.attributes?.mention?.id===person.id))).toBe(true));
});

it('fades a live thread reply without animating the loaded thread history', async () => {
  const root = paginatedMessage('Existing thread root', '1');
  mockPaginatedChat(() => messagePage([root]), '1');
  render(<Chat />);
  await screen.findByText(root.text);
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  const thread = screen.getByRole('region', { name: 'Thread', exact: true });
  const history = await within(thread).findByText(root.text);
  expect(history.closest('article')!.style.opacity).toBe('1');
  const reply = paginatedMessage('A new live thread reply', '2');
  await act(async () => { mocks.sockets.at(-1).receive('chat.events', { channel_id: 'first', cursor: '2', events: [{ type: 'message.created', channel_id: 'first', thread_id: 'thread', sequence: '2', occurred_at: reply.created_at, payload: reply }] }, vi.fn()); });
  const row = within(thread).getByText(reply.text).closest('article')!;
  expect(row.style.opacity).toBe('0');
  expect(row.style.transform).not.toMatch(/translate|scale/);
});

function sendReviewChannels() {
  const root = paginatedMessage('Send review root', '1');
  mockPaginatedChat(() => messagePage([root]), '1');
  const initialFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => String(args[0]).includes('/channels?')
    ? new Response(JSON.stringify({items:['first','second'].map(id=>({id,name:id,workspace_id:'workspace',joined:true})),next_cursor:null}))
    : initialFetch(...args));
  return root;
}
it.each([false,true])('clears a text-only acknowledged draft after leaving its composer: thread=%s', async inThread => {
  let acknowledge!: () => void;
  mocks.pendingSend = new Promise<void>(resolve => { acknowledge = resolve; });
  sendReviewChannels();
  render(<Chat />);
  await screen.findByRole('textbox', {name:'Message first'});
  if (inThread) await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
  const editor = await screen.findByRole('textbox',{name:inThread?'Message thread':'Message first'});
  await userEvent.type(editor,'Sent before leaving');
  fireEvent.keyDown(editor,{key:'Enter'});
  if (inThread) await userEvent.click(screen.getByRole('button',{name:'Close thread'}));
  else await userEvent.click(screen.getByRole('button',{name:'second',exact:true}));
  await waitFor(()=>expect(editor.isConnected).toBe(false));
  await act(async()=>{acknowledge();await mocks.pendingSend;});
  if (inThread) await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
  else await userEvent.click(screen.getByRole('button',{name:'first',exact:true}));
  expect((await screen.findByRole('textbox',{name:inThread?'Message thread':'Message first'})).textContent?.trim()).toBe('');
});
it('keeps thread replies out of the channel and updates the root count on duplicate delivery',async()=>{
  const root = {...paginatedMessage('Thread root only','1'),thread_root_id:'Thread root only',reply_count:3};
  mockPaginatedChat(()=>messagePage([root]),'1');
  render(<Chat />);
  await screen.findByText(root.text);
  await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
  const thread=screen.getByRole('region',{name:'Thread',exact:true});
  await within(thread).findByText(root.text);
  const reply={...paginatedMessage('Thread reply only','2'),thread_root_id:root.id,reply_count:4};
  await act(async()=>{for(let i=0;i<2;i++)mocks.sockets.at(-1).receive('chat.events',{channel_id:'first',cursor:'2',events:[{type:'message.created',channel_id:'first',thread_id:'thread',sequence:'2',occurred_at:reply.created_at,payload:reply}]},vi.fn());});
  expect(within(thread).getByText(reply.text)).toBeTruthy();
  const channel=screen.getByLabelText('Messages in first');
  expect(within(channel).queryByText(reply.text)).toBeNull();
  expect(within(channel).getByRole('button',{name:/4 replies/})).toBeTruthy();
});
it.each([false,true])('reveals an acknowledged send from older history even before socket delivery: thread=%s',async inThread=>{
  const root=paginatedMessage('Historical root','1');
  const own={...paginatedMessage('Acknowledged new message','9',inThread?'thread':'new-thread'),thread_root_id:inThread?root.id:'Acknowledged new message',reply_count:inThread?1:0};
  let sent=false;
  mockPaginatedChat(path=>messagePage(sent?[root,own]:[root],{has_newer:!sent}),'1');
  render(<Chat />);
  await screen.findByRole('textbox',{name:'Message first'});
  if(inThread)await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
  const editor=await screen.findByRole('textbox',{name:inThread?'Message thread':'Message first'});
  await userEvent.type(editor,own.text);
  // The acknowledgment includes the saved message, while realtime delivery can arrive later.
  const socket=mocks.sockets.at(-1), originalTimeout=socket.timeout;
  socket.timeout=()=>({emitWithAck:async(name:string,data:any)=>name==='message.send'?(sent=true,{data:own}):originalTimeout().emitWithAck(name,data)});
  fireEvent.keyDown(editor,{key:'Enter'});
  const timeline=within(screen.getByLabelText(inThread?'Thread messages':'Messages in first'));
  await timeline.findByText(own.text);
  await waitFor(()=>expect(editor.textContent?.trim()).toBe(''));
});
