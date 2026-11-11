import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from '@space/ui/primitives';
import userEvent from '@testing-library/user-event';
import { Chat } from './Chat.js';
import type { ChannelPermissionSnapshot, ChatMessage, MessagePage } from '@space/contracts';

it('renders live structured agent responses and replaces activity with one saved response', async () => {
  const root = paginatedMessage('Root message', '1');
  mockPaginatedChat(() => messagePage([root]), '1');
  render(<Chat />);
  await screen.findByText(root.text);
  await userEvent.click(within(document.querySelector('main.chat-channel')!).getByRole('tab', {name:'Messages'}));
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  await within(screen.getByRole('region', { name: 'Thread', exact: true })).findByText(root.text);
  const socket = latestChatSocket();
  const response = { messages: [{ id: 'm', text: '**Streaming result**', status: 'streaming' }], tools: [], components: [{ id: 'c', type: 'card', title: 'Churn analysis', body: 'Down 2%' }] };
  const activity = { channel_id: 'first', thread_id: 'thread', sequence: '2', occurred_at: root.created_at, type: 'task.event', payload: { task_id: 'task', type: 'execution.progress', actor_id: 'agent', installation_id: 'agent', owner_id: 'user', data: { text: 'Working', response } } };
  await act(async () => { socket.receive('chat.events', { channel_id: 'first', cursor: '2', events: [activity] }, vi.fn()); });
  const thread = screen.getByRole('region', { name: 'Thread', exact: true });
  const body = thread.querySelector('.sp-agent-markdown')!;
  await waitFor(() => expect(body.querySelector('strong')?.textContent).toBe('Streaming result'));
  const word = body.querySelector('.sp-agent-word');
  expect(word).toBeTruthy();
  const extended = { ...response, messages: [{ ...response.messages[0]!, text: '**Streaming result** is ready.' }] };
  await act(async () => { socket.receive('chat.events', { channel_id: 'first', cursor: '3', events: [
    { ...activity, sequence: '3', payload: { ...activity.payload, data: { text: 'Working', response: extended } } },
  ] }, vi.fn()); });
  await waitFor(() => expect(body.textContent).toBe('Streaming result is ready.'));
  expect(thread.querySelector('.sp-agent-word')).toBe(word);
  expect(screen.getByText('Down 2%')).toBeTruthy();
  const saved = { ...paginatedMessage('Final result', '4'), thread_root_id: root.id, reply_count: 1, task_id: 'task', text: extended.messages[0]!.text, agent_response: { ...extended, messages: [{ ...extended.messages[0]!, status: 'complete' }] }, author: { kind: 'agent', id: 'agent', name: 'Research agent' } };
  await act(async () => { socket.receive('chat.events', { channel_id: 'first', cursor: '5', events: [
    { type: 'message.created', channel_id: 'first', thread_id: 'thread', sequence: '4', occurred_at: root.created_at, payload: saved },
    { ...activity, sequence: '5', payload: { ...activity.payload, type: 'task.completed', data: { result: saved.text, response: saved.agent_response } } },
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
const mocks = vi.hoisted(() => ({ sockets: [] as any[], sessionId: 'session-a', authPending: false, refetch: vi.fn(), upload: vi.fn(), sendFailures: 0, pendingSend: undefined as undefined | Promise<void>, timelineRenders: 0, channelPost: true, channelReply: true, permissionsError: false, badgeOverride: false, setBadge: undefined as undefined | ((count:number)=>void) }));
const latestChatSocket = () => mocks.sockets.at(-1);
vi.mock('../shared/api/request.js', async original => {
  const actual = await original<typeof import('../shared/api/request.js')>();
  return { ...actual, request: async (...args: Parameters<typeof actual.request>) => {
    if (/^\/channels\/[^/]+\/permissions$/.test(args[0])) {
      if (mocks.permissionsError) throw new Error('offline');
      return { revision: '1', posting: 'everyone', poster_ids: [], manager_ids: [], allow_replies: true, allow_broadcast: true, invite: 'managers', remove: 'managers', edit_details: 'managers', archive: 'managers', capabilities: { post: mocks.channelPost, reply: mocks.channelReply, broadcast: true, invite: true, remove: true, edit_details: true, archive: true, manage: true } } satisfies ChannelPermissionSnapshot;
    }
    return actual.request(...args);
  } };
});
vi.mock('../features/files/assets.js', () => ({ uploadAsset: mocks.upload }));
vi.mock('../features/notifications/Notifications.js', async original => {
  const actual = await original<typeof import('../features/notifications/Notifications.js')>();
  const { useState } = await import('react');
  return { ...actual, useNotificationDelivery: (...args: Parameters<typeof actual.useNotificationDelivery>) => {
    const delivered = actual.useNotificationDelivery(...args);
    const [count, setCount] = useState(0); mocks.setBadge = setCount;
    return mocks.badgeOverride ? count : delivered;
  } };
});
vi.mock('../features/auth/auth-client.js', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'user', name: 'Kai' }, session: { id: mocks.sessionId } }, isPending: mocks.authPending, error: null, refetch: mocks.refetch }), signOut: vi.fn() } }));
vi.mock('socket.io-client', () => ({ io: () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const client = { connected: false, off: (name: string, fn: (...args: any[]) => void) => { if (handlers.get(name) === fn) handlers.delete(name); }, on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
    connect: () => { client.connected = true; handlers.get('connect')?.(); },
    disconnect: vi.fn(() => { client.connected = false; }),
    requests: [] as any[],
    timeout: () => ({ emitWithAck: async (name: string, data: any) => { client.requests.push({ name, data }); if (name === 'call.subscribe') return {data:{call:null,config:{iceServers:[],iceTransportPolicy:'all',hasTurn:false}}}; if (name === 'message.send' && mocks.pendingSend) await mocks.pendingSend; if (name === 'message.send' && mocks.sendFailures-- > 0) throw new Error('timed out'); return { data: name === 'message.send' ? { ...paginatedMessage(data.text, '1000', data.thread_id ?? data.client_message_id), id: data.client_message_id, client_message_id: data.client_message_id, document: data.document, thread_root_id: data.thread_id ? 'Send review root' : data.client_message_id } : data }; } }),
    receive: (name: string, ...args: any[]) => handlers.get(name)?.(...args),
  };
  mocks.sockets.push(client); return client;
} }));
afterEach(() => { localStorage.removeItem('space:composer-drafts:user'); cleanup(); window.history.replaceState(null, '', '/chat'); localStorage.clear(); vi.unstubAllGlobals(); mocks.sockets.length = 0; mocks.upload.mockReset(); mocks.sendFailures = 0; mocks.pendingSend = undefined; mocks.badgeOverride = false; mocks.setBadge = undefined; mocks.authPending = false; mocks.channelPost = true; mocks.channelReply = true; mocks.permissionsError = false; });
beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    getClientRects: { configurable: true, value: () => [] },
  });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () {
    if (this.open) { this.open = false; this.dispatchEvent(new Event('close')); }
  };
});
afterAll(() => { Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect'); Reflect.deleteProperty(Range.prototype, 'getClientRects'); });
async function switchWorkspace(name: string) {
  await userEvent.click(screen.getByRole('button', { name: /^Switch workspaces…/ }));
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
    if (path.endsWith('/first/tabs')) return {has_files:true,has_links:false,visibility:{}};
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
  const filesButton = within(document.querySelector('main.chat-channel')!).getByRole('tab', { name: 'Files & links', exact: true });
  await userEvent.click(filesButton);
  const files = await screen.findByRole('region', { name: 'Files in #first' });
  await within(files).findByText('older-report.pdf');
  expect(filesButton.getAttribute('aria-selected')).toBe('true');
  const listReads = vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('/first/assets?')).length;
  await act(async () => { latestChatSocket().receive('chat.events', { channel_id: 'first', cursor: '2', events: [{ channel_id: 'first', thread_id: 'new-thread', sequence: '2', occurred_at: message.created_at, type: 'message.created', payload: { ...message, id: 'new-file-message', thread_id: 'new-thread', text: 'New file shared', attachments: [file], author: { kind: 'human', id: 'alex', name: 'Alex' } } }] }, vi.fn()); });
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
  await userEvent.click(within(document.querySelector('main.chat-channel')!).getByRole('tab', {name:'Messages'}));
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  await screen.findByRole('region', { name: 'Thread' });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Files in #first' })).toBeNull());
  await userEvent.click(filesButton);
  await screen.findByRole('region', { name: 'Files in #first' });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Thread' })).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Search in first' }));
  await screen.findByRole('dialog', { name: 'Search in first' });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Files in #first' })).toBeNull());
  fireEvent(screen.getByRole('dialog', { name: 'Search in first' }), new Event('close'));
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
  await act(async () => { latestChatSocket().receive('disconnect', 'transport close'); });
  await userEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Files in #first' })).toBeNull());
  expect(screen.queryByRole('button', { name: 'View message for older-report.pdf' })).toBeNull();
  expect(screen.queryByText('Loaded conversation')).toBeNull();
  expect(filesButton.isConnected).toBe(false);
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
      if (path.endsWith('/first/tabs')) return {has_files:true,has_links:false,visibility:{}};
    if (path.includes('/first/assets?')) return { items: [file], next_cursor: null };
      if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
    } };
  }));
  render(<Chat />);
  await screen.findByText('Cached channel message');
  await userEvent.click(within(document.querySelector('main.chat-channel')!).getByRole('tab', { name: 'Files & links', exact: true }));
  await userEvent.click(await screen.findByRole('button', { name: 'View message for old.pdf' }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('/first/assets?'))).toHaveLength(2));
  if (revoked) {
    await waitFor(() => expect(screen.queryByText('Cached channel message')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Original message in #first' })).toBeNull();
    expect(within(document.querySelector('main.chat-channel')!).queryByRole('tab', { name: 'Files & links', exact: true })).toBeNull();
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
  const oldSocket = latestChatSocket();
  await userEvent.type(filter, 'second');
  await switchWorkspace('Team B');
  await screen.findByText('History other');
  expect(view.container.querySelector('.chat-app')).toBe(shell);
  expect(view.container.querySelector('.chat-sidebar')).toBe(sidebar);
  expect(screen.getByRole('searchbox', { name: 'Find a conversation' })).toBe(filter);
  expect((filter as HTMLInputElement).value).toBe('');
  expect(oldSocket.disconnect).not.toHaveBeenCalled();
  expect(mocks.sockets).toHaveLength(1);
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
  expect(socket.disconnect).not.toHaveBeenCalled();
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
  expect(screen.getByRole('button', { name: `Search Team ${returnToOriginal ? 'A' : 'B'} ⌘ K` })).toHaveProperty('disabled', false);
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
  const oldSocket = latestChatSocket();
  await switchWorkspace('Team B');
  expect(screen.queryByText('History first')).toBeNull();
  expect(oldSocket.disconnect).not.toHaveBeenCalled();
  expect(mocks.sockets).toHaveLength(1);
  expect(screen.queryByRole('heading', { name: 'A place for every conversation' })).toBeNull();
  expect(screen.queryByText('No conversations found.')).toBeNull();
  expect(screen.getByRole('status', { name: 'Loading workspace' })).toBeTruthy();
  expect(screen.getByText('Loading conversations…').classList.contains('sp-sr-only')).toBe(true);
  expect(document.querySelector('.chat-conversation-skeleton')).toBeNull();
  await act(async () => { finishChannels({ items: [{ id: 'second', name: 'second', workspace_id: 'b', joined: true }], next_cursor: null }); });
  expect(screen.getByRole('status', { name: 'Loading messages' }).classList.contains('sp-sr-only')).toBe(true);
  expect(screen.queryByRole('heading', { name: 'Opening #second' })).toBeNull();
  await act(async () => { finishHistory(history('second')); });
  const historyMessage = await screen.findByText('History second');
  expect(historyMessage.closest('article')?.style.opacity).toBe('1');
  expect(screen.queryByRole('status', { name: 'Loading messages' })).toBeNull();
  expect(screen.queryByText('History first')).toBeNull();
});
it.each(['Home', 'DMs'])('keeps the conversation layout while a shared self DM opens in %s', async destination => {
  const channel = '550e8400-e29b-41d4-a716-446655440000';
  const dm = { id: channel, workspace_id: 'team', kind: 'direct', joined: true, name: 'Kai (you)', participants: [{ id: 'user', name: 'Kai' }] };
  let finishLocation!: (value: unknown) => void, finishMetadata!: (value: unknown) => void, finishHistory!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => {
    if (url.startsWith('/v1/workspaces?')) return { items: [{ id: 'team', name: 'Team' }], next_cursor: null };
    if (url.endsWith('/location')) return new Promise(resolve => { finishLocation = resolve; });
    if (url.includes('/team/channels?') && destination === 'Home') return new Promise(resolve => { finishMetadata = resolve; });
    if (url === `/v1/channels/${channel}` && destination === 'DMs' && !finishMetadata) return new Promise(resolve => { finishMetadata = resolve; });
    if (url === `/v1/channels/${channel}`) return dm;
    if (isMessageHistory(url)) return new Promise(resolve => { finishHistory = resolve; });
    if (url.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  window.history.replaceState({ spaceView: destination }, '', '/c/VQ6EAOKbQdSnFkRmVUQAAA');
  mocks.authPending = true;
  const view = render(<Chat />);
  const expectConversationFrame = () => {
    expect(view.container.querySelector('.chat-app .chat-channel-header')).toBeTruthy();
    expect(view.container.querySelector('.chat-compose')).toBeTruthy();
    expect(view.container.querySelector('.chat-conversation-skeleton')).toBeNull();
  };
  expectConversationFrame();
  mocks.authPending = false;
  view.rerender(<Chat />);
  expectConversationFrame();
  await waitFor(() => expect(finishLocation).toBeTypeOf('function'));
  await act(async () => finishLocation({ workspace_id: 'team' }));
  await waitFor(() => expect(finishMetadata).toBeTypeOf('function'));
  expect(screen.queryByText('A conversation starts here')).toBeNull();
  expectConversationFrame();
  await act(async () => finishMetadata(destination === 'Home' ? { items: [], next_cursor: null } : dm));
  await screen.findByRole('status', { name: 'Loading messages' });
  expectConversationFrame();
  expect(screen.queryByText('Your space for notes, links, and files.')).toBeNull();
  const composer = screen.getByRole('textbox', { name: 'Message Kai (you)' });
  await act(async () => finishHistory(messagePage()));
  await screen.findByText('Your space for notes, links, and files.');
  expect(screen.getByRole('textbox', { name: 'Message Kai (you)' })).toBe(composer);
});

it('opens a copied thread in its workspace and restores the channel on browser Back', async () => {
  const channel = '550e8400-e29b-41d4-a716-446655440000';
  const thread = '00000000-0000-4000-8000-000000000001';
  const path = '/c/VQ6EAOKbQdSnFkRmVUQAAA';
  const threadPath = path + '/thread/AAAAAAAAQACAAAAAAAAAAQ';
  const root = { ...paginatedMessage('Shared discussion', '1', thread), channel_id: channel };
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => {
    requests.push(url);
    if (url === '/v1/me') return { id: 'user', display_name: 'Kai' };
    if (url.startsWith('/v1/workspaces?')) return { items: [{ id: 'first', name: 'Other' }, { id: 'target', name: 'Team' }], next_cursor: null };
    if (url.startsWith(`/v1/channels/${channel}/location`)) return { workspace_id: 'target' };
    if (url.includes('/target/channels?')) return { items: [{ id: channel, name: 'design', workspace_id: 'target', joined: true }], next_cursor: null };
    if (isMessageHistory(url)) return messagePage([root]);
    if (url.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  window.history.replaceState(null, '', path);
  const sender = render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: 'Reply to Kai' }));
  expect(location.pathname).toBe(threadPath);
  const back = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
  await act(async () => { window.history.back(); await back; });
  await screen.findByRole('button', { name: 'Channel details for #design' });
  expect(screen.queryByRole('region', { name: 'Thread', exact: true })).toBeNull();
  expect(location.pathname).toBe(path);
  sender.unmount();
  window.history.replaceState(null, '', threadPath);
  render(<Chat />);
  const panel = await screen.findByRole('region', { name: 'Thread', exact: true });
  await within(panel).findByText('Shared discussion');
  expect(requests).toContain(`/v1/channels/${channel}/location?thread=${thread}`);
  expect(requests.some(url => url.includes('/first/channels'))).toBe(false);
});

it('opens an old workspace bookmark and shares its Activity view with a compact path', async () => {
 const workspace='b232851a-61d8-44f5-a514-c7b0405694c2';
 window.history.replaceState({spaceView:'Activity'},'', '/chat?workspace='+workspace);
 mockPaginatedChat(()=>messagePage([]));
 const fallback=vi.mocked(fetch).getMockImplementation()!;
 vi.mocked(fetch).mockImplementation(async(input,init)=>String(input).startsWith('/v1/workspaces?')
   ? {ok:true,json:async()=>({items:[{id:'other',name:'Other'},{id:workspace,name:'Target'}],next_cursor:null})} as Response : fallback(input,init));
 const mounted=render(<Chat/>);
 const path='/w/sjKFGmHYRPWlFMewQFaUwg/activity';
 await waitFor(()=>expect(location.pathname+location.search).toBe(path));
 mounted.unmount();
 window.history.replaceState(null,'',path);
 render(<Chat/>);
 await screen.findByRole('button',{name:'Switch workspaces… (Target)'});
 expect(location.pathname).toBe(path);
});

it.each(['legacy', 'compact'])('opens the exact message from a %s link and returns to the channel on close', async format => {
 const room='550e8400-e29b-41d4-a716-446655440000', id='00000000-0000-4000-8000-000000000001';
 const channelPath='/c/VQ6EAOKbQdSnFkRmVUQAAA', path=channelPath+'/message/AAAAAAAAQACAAAAAAAAAAQ';
 window.history.replaceState(null,'',format==='compact' ? path : '/chat?workspace=workspace&channel='+room+'&message='+id);
 const message={...paginatedMessage('Linked original','1',id),channel_id:room};
 mockPaginatedChat(()=>messagePage([message]));
 const fallback=vi.mocked(fetch).getMockImplementation()!;
 vi.mocked(fetch).mockImplementation(async(input,init)=>{
   const url=String(input);
   if(url.startsWith('/v1/workspaces/workspace/channels?'))return {ok:true,json:async()=>({items:[{id:room,name:'design',workspace_id:'workspace',joined:true}],next_cursor:null})} as Response;
   if(url===`/v1/channels/${room}/location`)return {ok:true,json:async()=>({workspace_id:'workspace'})} as Response;
   if(url===`/v1/channels/${room}/messages/${id}`)return {ok:true,json:async()=>message} as Response;
   return fallback(input,init);
 });
 render(<Chat/>);
 const dialog=await screen.findByRole('dialog',{name:'Original message in #design'});
 expect(await within(dialog).findByText('Linked original')).toBeTruthy();
 expect(location.pathname+location.search).toBe(path);
 await userEvent.click(within(dialog).getByRole('button',{name:'Close dialog'}));
 await waitFor(()=>expect(location.pathname+location.search).toBe(channelPath));
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
    if (path.endsWith('/memory/agents')) return { items: [] };
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
  expect(screen.getByText('Agent')).toBeTruthy();
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
  expect(screen.queryByRole('button', { name: 'Ask an agent', exact: true })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  await screen.findByText('Second channel message');
  await userEvent.click(screen.getByRole('button', { name: 'Back in history' }));
  await screen.findByText('First channel message');
  expect((screen.getByRole('button', { name: 'Search Team ⌘ K' }) as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Forward in history' }));
  await screen.findByText('Second channel message');
  expect(screen.queryByText('First channel message')).toBeNull();
  expect((await screen.findByRole('textbox', { name: 'Message second' })).textContent?.trim()).toBe('');
  expect(mocks.sockets).toHaveLength(1);
  expect(latestChatSocket().requests.some((r: any) => r.name === 'channel.unsubscribe' && r.data.channel_id === 'first')).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'first', exact: true }));
  expect((await screen.findByRole('textbox', { name: 'Message first' })).textContent).toContain('Private draft');
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Helper' }));
  expect((await screen.findByRole('textbox', { name: 'Message thread' })).textContent).toContain('Thread draft');
  await userEvent.click(screen.getByRole('button', { name: 'Close thread', exact: true }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close thread' })).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Helper' }));
  expect((await screen.findByRole('textbox', { name: 'Message thread' })).textContent).toContain('Thread draft');
  await userEvent.click(screen.getByRole('button', { name: 'Search in first' }));
  const searchDialog = screen.getByRole('dialog', { name: 'Search in first' });
  expect(within(searchDialog).getByRole('searchbox', { name: 'Search messages' })).toBeTruthy();
  fireEvent(searchDialog, new Event('close'));
  await userEvent.click(screen.getByRole('button', { name: 'Close thread', exact: true }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close thread' })).toBeNull());
  await switchWorkspace('Another team');
  await screen.findByRole('heading', { name: 'A place for every conversation' });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Switch workspaces… (Another team)' })));
  expect((screen.getByRole('button', { name: 'Search Another team ⌘ K' }) as HTMLButtonElement).disabled).toBe(false);
  await switchWorkspace('Team');
  expect((await screen.findByRole('textbox', { name: 'Message first' })).textContent).toContain('Private draft');
  await userEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  await screen.findByText('Second channel message');
  const current = latestChatSocket();
  act(() => { current.receive('chat.events', { channel_id: 'second', events: [{ ...message('second', 'Live replay'), sequence: '2', payload: { ...message('second', 'Live replay').payload, id: 'new-message' } }], cursor: '2' }, () => {}); });
  const previousSubscriptions = current.requests.filter((r: any) => r.name === 'channel.subscribe' && r.data.channel_id === 'second').length;
  act(() => { current.receive('chat.error', { error: 'ack_timeout' }); current.connected = false; current.receive('disconnect', 'io server disconnect'); });
  expect(screen.getByText('Second channel message')).toBeTruthy();
  await waitFor(() => expect(current.requests.filter((r: any) => r.name === 'channel.subscribe' && r.data.channel_id === 'second')).toHaveLength(previousSubscriptions+1), { timeout: 2500 });
  expect(current.requests.filter((r: any) => r.name === 'channel.subscribe' && r.data.channel_id === 'second').at(-1).data.after).toBe('2');
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
  expect(latestChatSocket()).not.toBe(current);
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
  expect((await screen.findByRole('link', { name: /download.html/ })).getAttribute('href')).toBe('/v1/assets/saved-asset/download');
  expect(view.container.querySelector('iframe, img[src*="asset"], object')).toBeNull();
  expect(await screen.findByRole('button', { name: 'Open preview of download.html' })).toBeTruthy();
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
  await waitFor(() => expect(latestChatSocket().requests.some((r: any) => r.name === 'message.send' && r.data.thread_id === 'thread' && r.data.asset_ids[0] === 'thread-asset')).toBe(true));
  mocks.sendFailures = 1;
  await userEvent.click(buttons[0]!);
  await within(screen.getByLabelText('Messages in first')).findByRole('button', { name: 'Retry' });
  expect(screen.getByText('report.txt')).toBeTruthy();
  const firstReportAttempt = latestChatSocket().requests.filter((r: any) => r.name === 'message.send' && !r.data.thread_id)[0];
  await userEvent.click(screen.getByRole('button', { name: 'second', exact: true }));
  await screen.findByRole('textbox', { name: 'Message second' });
  await userEvent.click(screen.getByRole('button', { name: 'first', exact: true }));
  await screen.findByRole('textbox', { name: 'Message first' });
  await userEvent.click(await within(screen.getByLabelText('Messages in first')).findByRole('button', { name: 'Retry' }));
  const reportAttempts = latestChatSocket().requests.filter((r: any) => r.name === 'message.send' && !r.data.thread_id);
  expect(reportAttempts[0]).toBe(firstReportAttempt);
  expect(reportAttempts).toHaveLength(2);
  expect(reportAttempts[1].data.client_message_id).toBe(reportAttempts[0].data.client_message_id);
  await waitFor(() => expect(latestChatSocket().requests.some((r: any) => r.name === 'message.send' && !r.data.thread_id && r.data.asset_ids[0] === 'report-asset')).toBe(true));
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
  act(() => latestChatSocket().receive('chat.error', { error: 'not_found' }));
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

it('creates an additional workspace from the rail and selects the returned workspace', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => ({ ok: true, json: async () => {
    if (path === '/v1/workspaces' && options?.method === 'POST') return { id: 'created', name: 'New team', role: 'owner' };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'original', name: 'Team' }], next_cursor: null };
    if (path.includes('/channels?')) return { items: [], next_cursor: null };
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return {};
  } })));
  render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: 'Switch workspaces… (Team)' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Add a workspace' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Create a new workspace' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Workspace name' }), 'New team');
  await userEvent.click(screen.getByRole('button', { name: 'Create workspace', exact: true }));
  await screen.findByRole('button', { name: 'Switch workspaces… (New team)' });
  expect(vi.mocked(fetch).mock.calls.some(([path, options]) => path === '/v1/workspaces' && options?.method === 'POST' && options.body === JSON.stringify({ name: 'New team' }))).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Switch workspaces… (New team)' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Team', exact: true }));
  await screen.findByRole('button', { name: 'Switch workspaces… (Team)' });
});

it('creates a workspace directly from onboarding and opens the returned workspace', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => ({ ok: true, json: async () => {
    if (path === '/v1/workspaces' && options?.method === 'POST') return { id: 'created', name: 'Space studio', role: 'owner' };
    if (path.startsWith('/v1/workspaces?')) return { items: [], next_cursor: null };
    if (path.includes('/created/channels?')) return { items: [], next_cursor: null };
    return {};
  } })));
  render(<Chat />);
  const workspaceName = await screen.findByRole('textbox', { name: 'Workspace name' });
  expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  await userEvent.type(workspaceName, 'Space studio');
  await userEvent.click(screen.getByRole('button', { name: 'Create workspace', exact: true }));
  await screen.findByRole('button', { name: 'Switch workspaces… (Space studio)' });
  expect(vi.mocked(fetch).mock.calls.some(([path, options]) => path === '/v1/workspaces' && options?.method === 'POST' && options.body === JSON.stringify({ name: 'Space studio' }))).toBe(true);
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('/organizations'))).toBe(false);
  expect(screen.queryByText(/organization/i)).toBeNull();
});

it('keeps navigation hidden during workspace discovery and retries a failed load before showing setup', async () => {
  let finish!: (response: unknown) => void;
  let attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.startsWith('/v1/workspaces?')) {
      attempts++;
      if (attempts === 1) return new Promise(resolve => { finish = resolve; });
      return { ok: true, json: async () => ({ items: [], next_cursor: null }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  render(<Chat />);
  await waitFor(() => expect(attempts).toBe(1));
  expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Workspace name' })).toBeNull();
  await act(async () => { finish({ ok: false, status: 503, json: async () => ({ error: 'temporarily_unavailable' }) }); });
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: 'Try again', exact: true }));
  await screen.findByRole('textbox', { name: 'Workspace name' });
  expect(attempts).toBe(2);
});

it('validates workspace names locally and preserves the form after a failed creation', async () => {
  let creates = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/v1/workspaces' && options?.method === 'POST') {
      creates++;
      return { ok: false, status: 503, json: async () => ({ error: 'temporarily_unavailable' }) };
    }
    return { ok: true, json: async () => ({ items: [], next_cursor: null }) };
  }));
  render(<Chat />);
  const input = await screen.findByRole('textbox', { name: 'Workspace name' });
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.submit(input.closest('form')!);
  expect(creates).toBe(0);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  fireEvent.change(input, { target: { value: 'My team' } });
  await userEvent.click(screen.getByRole('button', { name: 'Create workspace', exact: true }));
  await screen.findByRole('alert');
  expect(input).toHaveProperty('value', 'My team');
  expect(creates).toBe(1);
});

function paginatedMessage(id: string, sequence: string, thread = 'thread'): ChatMessage {
  return { id, sequence, channel_id: 'first', thread_id: thread, created_at: '2026-11-03T00:00:00Z', text: id, author: { kind: 'human', id: 'user', name: 'Kai' } };
}
it.each([false,true])('keeps the channel mounted behind the thread transition and scopes interaction to the visible panel: compact=%s',async compact=>{
  vi.stubGlobal('matchMedia',(query:string)=>({matches:query==='(max-width: 1150px)'&&compact,media:query,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}}));
  mockPaginatedChat(()=>messagePage([paginatedMessage('Source message','1')]));
  const view=render(<Chat />);await screen.findByText('Source message');
  const channel=view.container.querySelector('#chat-messages')!;
  Object.defineProperty(channel.parentElement!, 'clientWidth', { value: 1000 });
  const trigger=screen.getByRole('button',{name:'Reply to Kai'});
  await userEvent.click(trigger);
  const panel=await screen.findByRole('region',{name:'Thread',exact:true});
  expect(document.activeElement).toBe(panel);
  expect(channel.isConnected).toBe(true);
  expect(channel.getAttribute('aria-hidden')).toBe(compact?'true':null);
  expect(channel.hasAttribute('inert')).toBe(compact);
  const divider = screen.queryByRole('separator', { name: 'Right sidebar width' });
  if (compact) expect(divider).toBeNull();
  else {
    expect(divider?.getAttribute('aria-valuenow')).toBe('400');
    fireEvent.keyDown(divider!, { key: 'ArrowLeft' });
    expect((channel.parentElement as HTMLElement).style.getPropertyValue('--conversation-panel-width')).toBe('410px');
  }
  await userEvent.click(screen.getByRole('button',{name:'Close thread'}));
  expect(channel.getAttribute('aria-hidden')).toBeNull();
  expect(channel.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(trigger);
});
it('reveals the initialized thread composer with its history without replacing the editor',async()=>{
  const root=paginatedMessage('Delayed thread parent','1');
  let finish!:(page:MessagePage)=>void;
  mockPaginatedChat(path=>path.includes('/threads/')?new Promise(resolve=>{finish=resolve;}):messagePage([root]));
  render(<Chat />);await screen.findByText(root.text);
  await act(async()=>{latestChatSocket().receive('chat.events',{channel_id:'first',cursor:'1000',events:[{channel_id:'first',thread_id:'thread',sequence:'1000',occurred_at:root.created_at,type:'task.event',payload:{task_id:'loading-task',type:'task.proposed',owner_id:'user',actor_id:'user',installation_id:'agent',data:{goal:'Thread activity before history'}}}]},vi.fn());});
  await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
  const thread=screen.getByRole('region',{name:'Thread',exact:true});
  await within(thread).findByText('Loading thread…');
  expect(within(thread).queryByText('Thread activity before history')).toBeNull();
  await waitFor(()=>expect(thread.querySelector('.chat-compose [role="textbox"]')).not.toBeNull());
  const editor=thread.querySelector('.chat-compose [role="textbox"]');
  expect(within(thread).queryByRole('textbox',{name:'Message thread'})).toBeNull();
  await act(async()=>{finish(messagePage([root]));});
  expect(await within(thread).findByRole('textbox',{name:'Message thread'})).toBe(editor);
  expect(within(thread).getByText('Thread activity before history')).toBeTruthy();
});
it.each([0,1,7])('places the thread composer after its replies and shows the saved reply count: %s',async count=>{
  const root={...paginatedMessage('Thread parent','1'),thread_root_id:'Thread parent',reply_count:count};
  const reply={...paginatedMessage('Thread reply','2'),thread_root_id:root.id,reply_count:count};
  mockPaginatedChat(path=>path.includes('/threads/')?messagePage(count?[root,reply]:[root],{has_newer:count>1}):messagePage([root]));
  render(<Chat />);await screen.findByText(root.text);
  await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
  const thread=screen.getByRole('region',{name:'Thread',exact:true});
  await within(thread).findByText(root.text);
  const timeline=within(thread).getByLabelText('Thread messages');
  const editor=within(thread).getByRole('textbox',{name:'Message thread'});
  expect(timeline.contains(editor)).toBe(true);
  const divider=within(thread).queryByRole('separator',{name:`${count} ${count===1?'reply':'replies'}`});
  if(!count){expect(divider).toBeNull();return;}
  expect(divider).not.toBeNull();
  const parent=within(timeline).getByText(root.text),last=within(timeline).getByText(reply.text);
  expect(parent.compareDocumentPosition(divider!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(divider!.compareDocumentPosition(last)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(last.compareDocumentPosition(editor)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
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
it('updates the Starred sidebar immediately after starring and unstarring without a pushed event', async () => {
  mockPaginatedChat(() => messagePage());
  const fallback = vi.mocked(fetch).getMockImplementation()!;
  let active = false;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    if (!/\/hub\/starred(?:[/?]|$)/.test(path)) return fallback(input, init);
    if (init?.body) active = JSON.parse(String(init.body)).active;
    return { ok: true, json: async () => path.includes('/starred/') ? { active } : { items: active ? [{ id: 'first', name: 'first', kind: 'channel', private: false }] : [], next_cursor: null } } as Response;
  });
  render(<Chat />);
  const editor = await screen.findByRole('textbox', { name: 'Message first' });
  const section = screen.getByRole('button', { name: 'Starred', exact: true }).closest('section')!;
  expect(within(section).queryByRole('button', { name: 'first', exact: true })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Star conversation', exact: true }));
  await screen.findByRole('button', { name: 'Unstar conversation', exact: true });
  await within(section).findByRole('button', { name: 'first', exact: true });
  expect(screen.getAllByRole('button', { name: 'first', exact: true })).toHaveLength(1);
  expect(screen.getByRole('textbox', { name: 'Message first' })).toBe(editor);
  await userEvent.click(screen.getByRole('button', { name: 'Unstar conversation', exact: true }));
  await screen.findByRole('button', { name: 'Star conversation', exact: true });
  await waitFor(() => expect(within(section).queryByRole('button', { name: 'first', exact: true })).toBeNull());
  expect(screen.getByRole('button', { name: 'first', exact: true })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Message first' })).toBe(editor);
});
function mockUnreadChat() {
  const session = { id: 'session-one', title: 'Research', agent_name: 'Codex' };
  const root = { ...paginatedMessage('Unread hello', '1'), author: { kind: 'human' as const, id: 'other', name: 'Teammate' }, agent_sessions: [session] };
  const snapshot = { workspace_id: 'workspace', channels: [
    { channel_id: 'first', last_read_sequence: '0', latest_sequence: '1', unread_count: 1 },
    { channel_id: 'second', last_read_sequence: '0', latest_sequence: '3', unread_count: 3 },
  ] };
  const fetch = vi.fn(async (path: string) => ({ ok: true, json: async () => {
    if (path === '/v1/me') return { id: 'user', display_name: 'Kai' };
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
    if (path.includes('/channels?')) return { items: ['first', 'second'].map(id => ({ id, name: id, workspace_id: 'workspace', joined: true })), next_cursor: null };
    if (path.endsWith('/unread')) return snapshot;
    if (path.endsWith('/agent-sessions/session-one')) return { session, turns: [], next_cursor: null };
    if (path.endsWith('/navigator')) return { candidates: [] };
    if (isMessageHistory(path)) return messagePage([root]);
    if (path.includes('/history')) return { events: [], cursor: '1', has_more: false };
    return [];
  } }));
  vi.stubGlobal('fetch', fetch);
  return { fetch, snapshot };
}
it('updates unopened channel badges from authoritative realtime snapshots without double counting', async () => {
  const { snapshot: base } = mockUnreadChat();
  // Channel badges count mentions unless the channel opts into a badge for every post.
  const snapshot = { ...base, channels: base.channels.map(c => ({ ...c, mention_count: c.unread_count })) };
  render(<Chat />);
  await waitFor(() => expect(mocks.sockets.some(s => s.requests.some((r: any) => r.name === 'workspace.subscribe'))).toBe(true));
  const socket = mocks.sockets.find(s => s.requests.some((r: any) => r.name === 'workspace.subscribe'));
  await act(async () => { socket.receive('workspace.unread', snapshot, vi.fn()); });
  await screen.findByLabelText('3 unread');
  const updated = { ...snapshot, channels: snapshot.channels.map(c => c.channel_id === 'second' ? { ...c, unread_count: 4, mention_count: 4, latest_sequence: '4' } : c) };
  await act(async () => { socket.receive('workspace.unread', updated, vi.fn()); socket.receive('workspace.unread', updated, vi.fn()); });
  expect(screen.getAllByLabelText('4 unread')).toHaveLength(1);
  expect(screen.queryByLabelText('3 unread')).toBeNull();
  await act(async () => { socket.receive('workspace.unread', { workspace_id: 'elsewhere', channels: [] }, vi.fn()); });
  expect(screen.getByLabelText('4 unread')).toBeTruthy();
});
it.each([false, true])('marks a channel read beside an agent session only when visible (compact=%s)', async compact => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media, matches: compact && media === '(max-width: 1150px)',
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  try {
    const { fetch, snapshot } = mockUnreadChat();
    render(<Chat />);
    await userEvent.click(await screen.findByRole('button', { name: 'Agent session: Research' }));
    await screen.findByRole('region', { name: 'Agent session', exact: true });
    const socket = mocks.sockets.find(s => s.requests.some((r: any) => r.name === 'workspace.subscribe'));
    await act(async () => { socket.receive('workspace.unread', snapshot, vi.fn()); });
    focus.mockReturnValue(true);
    fireEvent.focus(window);
    const reads = () => fetch.mock.calls.filter(([path]) => path === '/v1/channels/first/read');
    if (compact) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
      expect(reads()).toHaveLength(0);
      await userEvent.click(screen.getByRole('button', { name: 'Close agent session' }));
    }
    await waitFor(() => expect(reads()).toHaveLength(1));
  } finally { focus.mockRestore(); }
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
  const socket = latestChatSocket();
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
  Object.defineProperties(timeline, { clientHeight: { value: 400 }, scrollHeight: { value: 1200 } });
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
  expect(latestChatSocket().disconnect).not.toHaveBeenCalled();
  await act(async () => { finishOlder(messagePage([paginatedMessage('Late revoked history', '10')])); });
  expect(screen.queryByText('Late revoked history')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Message first' })).toBeNull();
});

it('replays from the earlier snapshot watermark so tasks between history reads are delivered', async () => {
  const message = paginatedMessage('Snapshot message', '90');
  mockPaginatedChat(() => messagePage([message], { event_cursor: '100' }), '99');
  render(<Chat />);
  await screen.findByText(message.text);
  const socket = latestChatSocket();
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
  const retry = await screen.findByRole('button', { name: 'Retry loading messages' }, { timeout: 5000 });
  const firstSocket = latestChatSocket();
  expect(firstSocket.connected).toBe(true);
  expect(firstSocket.requests.some((request: any) => request.name === 'channel.subscribe')).toBe(false);
  await userEvent.click(retry);
  await screen.findByText(message.text);
  await waitFor(() => expect(latestChatSocket().connected).toBe(true));
  expect(attempts).toBe(2);
  expect(vi.mocked(fetch).mock.calls.filter(([path]) => path === '/v1/channels/first/history')).toHaveLength(2);
  expect(firstSocket.disconnect).not.toHaveBeenCalled();
  const recoveredSocket = latestChatSocket();
  expect(recoveredSocket).toBe(firstSocket);
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
  const socket = latestChatSocket();
  act(() => { socket.connected = false; socket.receive('connect_error', new Error('internal_error')); });
  await waitFor(() => expect(socket.requests.filter((request: any) => request.name === 'channel.subscribe')).toHaveLength(2), { timeout: 2500 });
  expect(editor.textContent).toContain('Keep my unsent work');
  expect(screen.getByText('Saved conversation')).toBeTruthy();
  expect(socket.requests.filter((request: any) => request.name === 'channel.subscribe').at(-1).data.after).toBe('42');
});

function mockSessionForTask(task: any, managed = false) {
  const original = vi.mocked(fetch).getMockImplementation()!;
  const session = {id:task.session_id,workspace_id:'workspace',origin_thread_id:'thread',installation_id:'agent',title:'Existing agent session',state:'active',managed,created_by:'user',owner_id:'user',agent_name:'Research agent',created_at:'2026-11-03T00:00:00Z',skill:'demo.echo',turn_count:1};
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const path=String(args[0]);
    const data=path===`/v1/tasks/${task.id}`?task:path==='/v1/threads/thread/agent-sessions'?{items:[session],next_cursor:null}:path===`/v1/agent-sessions/${session.id}`?{session,turns:[{task,requester_name:'Kai',created_at:'2026-11-03T00:00:00Z',detail:task.result}],next_cursor:null}:path.endsWith('/navigator')?{candidates:[]}:undefined;
    return data===undefined?original(...args):{ok:true,json:async()=>data} as Response;
  });
}
it('opens a task inside its unified agent session and clears the session after revocation', async () => {
  mockPaginatedChat(() => messagePage([paginatedMessage('Conversation with an agent task','1')]));
  const task={id:'workspace-task',workspace_id:'workspace',thread_id:'thread',installation_id:'agent',goal:'Build the result viewer',skill:'demo.echo',requester_id:'user',approved_by:'user',status:'completed',session_id:'session',active_execution_id:'execution',revision:4,result:'The result is saved.'};
  mockSessionForTask(task);
  render(<Chat />);await screen.findByText('Conversation with an agent task');
  const socket=latestChatSocket();
  await act(async()=>{socket.receive('chat.events',{channel_id:'first',cursor:'2',events:[{channel_id:'first',thread_id:'thread',sequence:'2',occurred_at:'2026-11-03T08:00:00Z',type:'task.event',payload:{task_id:task.id,type:'task.completed',owner_id:'user',actor_id:'agent',installation_id:'agent',data:{goal:task.goal,result:task.result}}}]},vi.fn());});
  await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
  await userEvent.click(await screen.findByRole('button',{name:'Open agent session'}));
  await screen.findByRole('heading',{name:'Research agent',exact:true,level:1});
  await within(screen.getByRole('log',{name:'Session conversation'})).findByText('The result is saved.');
  const panel=screen.getByRole('region',{name:'Agent session',exact:true});
  expect(within(panel).queryByRole('button',{name:'New agent session'})).toBeNull();
  expect(within(panel).queryByRole('navigation',{name:'Sessions in this thread'})).toBeNull();
  await waitFor(()=>expect(screen.queryByRole('region',{name:'Thread',exact:true})).toBeNull());
  expect(screen.queryByRole('tab',{name:'Agent sessions',exact:true})).toBeNull();
  expect(screen.queryByRole('region',{name:'Agent workspace'})).toBeNull();
  await userEvent.click(screen.getByRole('tab',{name:'Preview',exact:true}));await screen.findByText('No preview attached');
  await act(async()=>{socket.receive('chat.error',{error:'not_found'});});
  await waitFor(()=>expect(screen.queryByRole('heading',{name:'Research agent',exact:true,level:1})).toBeNull());
  expect(screen.queryByText('Conversation with an agent task')).toBeNull();
});
it('renders saved agent replies without session action buttons in the channel or thread', async()=>{
  const saved={...paginatedMessage('Saved agent result','3'),task_id:'saved-task',author:{kind:'agent' as const,id:'agent',name:'Research agent'},agent_response:{messages:[{id:'m',text:'The report is ready.',status:'complete' as const}],tools:[],components:[]}};
  mockPaginatedChat(()=>messagePage([saved]));
  render(<Chat />);await screen.findByText('The report is ready.');
  expect(screen.queryByRole('button',{name:'Open agent session'})).toBeNull();
  await userEvent.click(screen.getByRole('button',{name:'Reply to Research agent'}));
  const thread=screen.getByRole('region',{name:'Thread',exact:true});
  await within(thread).findByText('The report is ready.');
  expect(within(thread).queryByRole('button',{name:'Open agent session'})).toBeNull();
});
it('keeps session management and agent follow-up controls out of the thread', async()=>{
  mockPaginatedChat(()=>messagePage([paginatedMessage('Source thread','1')]));
  mockSessionForTask({id:'saved-task',thread_id:'thread',session_id:'session',goal:'Earlier prompt',requester_id:'user',status:'completed',result:'Earlier reply',skill:'codex.run'},true);
  const original=vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async(...args)=>String(args[0]).endsWith('/agent-subscription')?{ok:true,json:async()=>({name:'Research agent',can_close:true})} as Response:original(...args));
  render(<Chat />);await screen.findByText('Source thread');
  await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
  const thread=screen.getByRole('region',{name:'Thread',exact:true});
  const editor=await within(thread).findByRole('textbox',{name:'Message thread'});
  await userEvent.type(editor,'Ordinary thread reply');
  expect(within(thread).queryByRole('button',{name:'New agent session'})).toBeNull();
  expect(within(thread).queryByRole('navigation',{name:'Sessions in this thread'})).toBeNull();
  expect(within(thread).queryByRole('button',{name:'Ask an agent'})).toBeNull();
  expect(within(thread).queryByText(/receives follow-ups in this thread/)).toBeNull();
  expect(within(thread).queryByRole('button',{name:'End agent follow-ups'})).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([path])=>/\/threads\/thread\/(agent-sessions|agent-subscription)$/.test(String(path)))).toBe(false);
  await userEvent.keyboard('{Enter}');
  await waitFor(()=>expect(editor.textContent?.trim()).toBe(''));
  expect(latestChatSocket().requests.some((item:any)=>item.name==='message.send'&&item.data.thread_id==='thread'&&item.data.text==='Ordinary thread reply')).toBe(true);
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
  await act(async () => { latestChatSocket().receive('chat.events',{channel_id:'first',cursor:'3',events:[{type:'message.updated',channel_id:'first',thread_id:root.thread_id,sequence:'3',occurred_at:root.created_at,payload:updated}]},vi.fn()); });
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
  if(path.includes('/profiles/user/'))return new Response(JSON.stringify({kind:'user',id:person.id,display_name:'Jamie Updated',full_name:'Jamie Updated',title:'Engineer',name_pronunciation:'',phone:'',time_zone:'UTC',image:null,email:'jamie@example.test',presence:'active',status:null}),{status:200});
  if(path.includes('/mentions?q='))return new Response(JSON.stringify({items:[person],member_count:2}),{status:200});
  if(path.endsWith('/mention-settings'))return new Response(JSON.stringify({paused_until:null,broadcast_permission:'all',can_manage:false,member_count:2,general_channel_id:'first'}),{status:200});
  if(path.endsWith('/mentions'))return new Response(JSON.stringify({items:[],unread_count:0,next_cursor:null}),{status:200});
  return original(...args);
 });
 render(<Chat/>);
 await userEvent.click(await screen.findByRole('button',{name:'@Jamie Chen'}));
 const profile=await screen.findByRole('region',{name:'Profile'});
 await within(profile).findByRole('heading',{name:'Jamie Updated'});
 await userEvent.click(within(profile).getByRole('button',{name:'Close profile'}));
 const editor=await screen.findByRole('textbox',{name:'Message first'});
 await userEvent.type(editor,'@Ja');await screen.findByRole('option',{name:/Jamie Chen/});await userEvent.keyboard('{Enter}');
 await userEvent.keyboard('review{Enter}');
 await waitFor(()=>expect(latestChatSocket().requests.some((r:any)=>r.name==='message.send'&&r.data.document.ops.some((op:any)=>op.attributes?.mention?.id===person.id))).toBe(true));
});

it('glides a live thread reply into place and shows loaded thread history immediately', async () => {
  const root = paginatedMessage('Existing thread root', '1');
  mockPaginatedChat(() => messagePage([root]), '1');
  render(<Chat />);
  await screen.findByText(root.text);
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  const thread = screen.getByRole('region', { name: 'Thread', exact: true });
  const history = await within(thread).findByText(root.text);
  expect(history.closest('article')!.style.opacity).toBe('1');
  const reply = paginatedMessage('A new live thread reply', '2');
  await act(async () => { latestChatSocket().receive('chat.events', { channel_id: 'first', cursor: '2', events: [{ type: 'message.created', channel_id: 'first', thread_id: 'thread', sequence: '2', occurred_at: reply.created_at, payload: reply }] }, vi.fn()); });
  const row = within(thread).getByText(reply.text).closest('article')!;
  expect(Number(row.style.opacity)).toBeLessThan(1);
  expect(row.style.transform).toMatch(/^translateX\(-/);
  await waitFor(() => {
    expect(row.style.transform).toBe('none');
    expect(row.style.opacity).toBe('1');
  });
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
  if (inThread) await userEvent.click(await screen.findByRole('button',{name:'Reply to Kai'}));
  const editor = await screen.findByRole('textbox',{name:inThread?'Message thread':'Message first'});
  await userEvent.type(editor,'Sent before leaving');
  fireEvent.keyDown(editor,{key:'Enter'});
  if (inThread) await userEvent.click(screen.getByRole('button',{name:'Close thread'}));
  else await userEvent.click(screen.getByRole('button',{name:'second',exact:true}));
  await waitFor(()=>expect(editor.isConnected).toBe(false));
  await act(async()=>{acknowledge();await mocks.pendingSend;});
  if (inThread) await userEvent.click(await screen.findByRole('button',{name:'Reply to Kai'}));
  else await userEvent.click(screen.getByRole('button',{name:'first',exact:true}));
  expect((await screen.findByRole('textbox',{name:inThread?'Message thread':'Message first'})).textContent?.trim()).toBe('');
});
it.each(['ack', 'realtime'])('keeps an Enter-sent channel message in the same grouped timeline row through %s delivery', async delivery => {
  let acknowledge!: () => void;
  mocks.pendingSend = new Promise<void>(resolve => { acknowledge = resolve; });
  const prior = { ...paginatedMessage('Previous message', '1'), created_at: new Date(Date.now() - 1000).toISOString() };
  mockPaginatedChat(() => messagePage([prior]), '1');
  render(<Chat />);
  const editor = await screen.findByRole('textbox', { name: 'Message first' });
  const socket = latestChatSocket(), originalTimeout = socket.timeout;
  const saved = { ...paginatedMessage('Next message', '2'), id: 'server-id', created_at: new Date().toISOString() };
  socket.timeout = () => ({ emitWithAck: async (name: string, data: any) => {
    const result = await originalTimeout().emitWithAck(name, data);
    return name === 'message.send' ? { data: { ...saved, client_message_id: data.client_message_id } } : result;
  } });
  await userEvent.type(editor, 'Next message{Enter}');
  const timeline = within(screen.getByLabelText('Messages in first'));
  const pending = (await timeline.findByText(saved.text)).closest('article')!;
  const row = pending.closest('[data-index]');
  expect(row).toBeTruthy();
  expect(pending.classList.contains('sp-message--grouped')).toBe(true);
  const clientId = socket.requests.find((request: any) => request.name === 'message.send').data.client_message_id;
  if (delivery === 'realtime') {
    await act(async () => socket.receive('chat.events', { channel_id: 'first', cursor: '2', events: [
      { type: 'message.created', channel_id: 'first', thread_id: saved.thread_id, sequence: '2', occurred_at: saved.created_at, payload: { ...saved, client_message_id: clientId } },
    ] }, vi.fn()));
  }
  await act(async () => { acknowledge(); await mocks.pendingSend; });
  const confirmed = timeline.getByText(saved.text).closest('article')!;
  expect(confirmed.closest('[data-index]')).toBe(row);
  expect(confirmed.classList.contains('sp-message--grouped')).toBe(true);
  expect(confirmed.style.opacity).toBe('1');
});

it.each([false, true])('shows a submission immediately and lets the sender discard a failed row: thread=%s', async inThread => {
  let rejectAttempt!: () => void;
  mocks.pendingSend = new Promise<void>(resolve => { rejectAttempt = resolve; });
  mocks.sendFailures = 1;
  sendReviewChannels();
  render(<Chat />);
  await screen.findByRole('textbox', { name: 'Message first' });
  if (inThread) await userEvent.click(await screen.findByRole('button', { name: 'Reply to Kai' }));
  const editor = await screen.findByRole('textbox', { name: inThread ? 'Message thread' : 'Message first' });
  const timeline = within(screen.getByLabelText(inThread ? 'Thread messages' : 'Messages in first'));
  await userEvent.type(editor, 'Message with a lost acknowledgement{Enter}');
  await timeline.findByText('Message with a lost acknowledgement');
  expect(editor.textContent?.trim()).toBe('');
  expect(timeline.queryByRole('button', { name: 'Retry' })).toBeNull();
  await userEvent.type(editor, 'My next message');
  await act(async () => { rejectAttempt(); await mocks.pendingSend; });
  await timeline.findByRole('button', { name: 'Retry' });
  await userEvent.click(timeline.getByRole('button', { name: 'Delete', exact: true }));
  expect(timeline.queryByText('Message with a lost acknowledgement')).toBeNull();
  expect(editor.textContent).toContain('My next message');
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
  await act(async()=>{for(let i=0;i<2;i++)latestChatSocket().receive('chat.events',{channel_id:'first',cursor:'2',events:[{type:'message.created',channel_id:'first',thread_id:'thread',sequence:'2',occurred_at:reply.created_at,payload:reply}]},vi.fn());});
  expect(within(thread).getByText(reply.text)).toBeTruthy();
  expect(within(thread).getByRole('separator',{name:'4 replies'})).toBeTruthy();
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
  if(inThread)await userEvent.click(await screen.findByRole('button',{name:'Reply to Kai'}));
  const editor=await screen.findByRole('textbox',{name:inThread?'Message thread':'Message first'});
  await userEvent.type(editor,own.text);
  // The acknowledgment includes the saved message, while realtime delivery can arrive later.
  const socket=latestChatSocket(), originalTimeout=socket.timeout;
  socket.timeout=()=>({emitWithAck:async(name:string,data:any)=>name==='message.send'?(sent=true,{data:{...own,client_message_id:data.client_message_id}}):originalTimeout().emitWithAck(name,data)});
  fireEvent.keyDown(editor,{key:'Enter'});
  const timeline=within(screen.getByLabelText(inThread?'Thread messages':'Messages in first'));
  await waitFor(() => expect(timeline.getByText(own.text).closest('.chat-message-anchor')).toBeTruthy());
  await waitFor(()=>expect(editor.textContent?.trim()).toBe(''));
});

it('opens a persistent agent session from its channel link without duplicating the link inside the thread',async()=>{
 const root={...paginatedMessage('Session request','1'),agent_sessions:[{id:'session-one',title:'Summarize this discussion',agent_name:'Codex'}]};
 const reference={...paginatedMessage('Summarize this discussion','2'),agent_session_id:'session-one',author:{kind:'agent' as const,id:'agent',name:'Codex'}};
 mockPaginatedChat(path=>path.includes('/threads/')?messagePage([root,reference]):messagePage([root]));
 const initialFetch=vi.mocked(fetch).getMockImplementation()!;
 const session={id:'session-one',title:reference.text,workspace_id:'workspace',origin_thread_id:'thread',installation_id:'agent',managed:true,state:'active',owner_id:'user',created_by:'user',agent_name:'Codex',turn_count:0};
 vi.mocked(fetch).mockImplementation(async(...args)=>{
  const path=String(args[0]);
  if(path==='/v1/threads/thread/agent-sessions')return new Response(JSON.stringify({items:[session],next_cursor:null}),{status:200});
  if(path==='/v1/agent-sessions/session-one')return new Response(JSON.stringify({session,turns:[],next_cursor:null}),{status:200});
  return initialFetch(...args);
 });
 render(<Chat/>);await screen.findByText(root.text);
 const channelLink=screen.getByRole('button',{name:`Agent session: ${reference.text}`});
 await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
 const thread=await screen.findByRole('region',{name:'Thread',exact:true});
 expect(within(thread).queryByRole('button',{name:`Agent session: ${reference.text}`})).toBeNull();
 expect(within(thread).getAllByRole('article')).toHaveLength(1);
 expect(thread.querySelector('.chat-history-edge--newer')).toBeNull();
 expect(thread.querySelector('.chat-history-edge--older')).toBeNull();
 await userEvent.click(channelLink);
 const sessionPanel=await screen.findByRole('region',{name:'Agent session',exact:true});
 expect(document.activeElement).toBe(sessionPanel);
 await screen.findByRole('textbox',{name:'Message agent session'});
 expect(screen.queryByRole('button',{name:'New agent session'})).toBeNull();
 expect(screen.queryByRole('navigation',{name:'Sessions in this thread'})).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'Back to thread'}));
 const returned=await screen.findByRole('region',{name:'Thread',exact:true});
 expect(document.activeElement).toBe(returned);
 expect(within(returned).queryByRole('button',{name:`Agent session: ${reference.text}`})).toBeNull();
 await userEvent.click(within(returned).getByRole('button',{name:'Close thread'}));
 await userEvent.click(await screen.findByRole('button',{name:`Agent session: ${reference.text}`}));
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.type(editor,'Retain this session draft');
 await userEvent.click(screen.getByRole('tab',{name:'Preview',exact:true}));
 await screen.findByRole('tabpanel',{name:'Preview',exact:true});
 await userEvent.click(screen.getByRole('button',{name:'Close agent session'}));
 expect(document.activeElement).toBe(channelLink);
 expect(sessionPanel.hasAttribute('inert')).toBe(true);
 await waitFor(()=>expect(sessionPanel.hidden).toBe(true));
 await userEvent.click(channelLink);
 expect(document.activeElement).toBe(sessionPanel);
 await userEvent.click(within(sessionPanel).getByRole('tab',{name:'Messages',exact:true}));
 const reopened=await screen.findByRole('textbox',{name:'Message agent session'});
 expect(reopened).toBe(editor);
 expect(reopened.textContent).toContain('Retain this session draft');
 expect(document.activeElement).toBe(within(sessionPanel).getByRole('tab',{name:'Messages',exact:true}));
});
it('keeps earlier thread history reachable when the current page contains only hidden session reference records',async()=>{
 const root={...paginatedMessage('Parent outside the current page','1'),agent_sessions:[{id:'session',title:'Research',agent_name:'Codex'}]};
 const ref={...paginatedMessage('Research','2'),agent_session_id:'session',thread_root_id:root.id};
 mockPaginatedChat(path=>path.includes('/threads/')&&!path.includes('?before=')?messagePage([ref],{has_older:true}):messagePage([root]));
 render(<Chat/>);await screen.findByText(root.text);
 await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
 const thread=await screen.findByRole('region',{name:'Thread',exact:true});
 await userEvent.click(await within(thread).findByRole('button',{name:'Load older history'}));
 expect(await within(thread).findByText(root.text)).toBeTruthy();
 expect(within(thread).queryByRole('button',{name:'Agent session: Research'})).toBeNull();
});

it('publishes local typing and displays other people separately in the channel and thread',async()=>{
 const root=paginatedMessage('Typing discussion','1');mockPaginatedChat(()=>messagePage([root]));render(<Chat/>);
 const editor=await screen.findByRole('textbox',{name:'Message first'}),socket=latestChatSocket();
 await screen.findByText('Typing discussion');
 await userEvent.type(editor,'Private draft');
 await waitFor(()=>expect(socket.requests.some((r:any)=>r.name==='typing.change'&&r.data.active)).toBe(true));
 expect(socket.requests.find((r:any)=>r.name==='typing.change').data).toEqual({channel_id:'first',active:true});
 const typing={channel_id:'first',thread_id:null,source_id:'ari-tab',user:{id:'ari',name:'Ari'},active:true,expires_at:Date.now()+6000};
 act(()=>socket.receive('chat.typing',typing));
 const indicator=(await screen.findByText('Ari')).closest('.chat-typing')!;
 const composer=indicator.closest('.chat-compose')!.querySelector('.sp-rich-composer')!;
 expect(!!(indicator.compareDocumentPosition(composer)&Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
 await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
 const thread=screen.getByRole('region',{name:'Thread',exact:true});await within(thread).findByRole('textbox',{name:'Message thread'});
 act(()=>socket.receive('chat.typing',{...typing,thread_id:'thread',source_id:'sam-tab',user:{id:'sam',name:'Sam'}}));
 expect(within(thread).getByText('Sam')).toBeTruthy();
 expect(within(thread).queryByText('Ari')).toBeNull();
 expect(screen.getByText('Ari').closest('main')?.classList.contains('chat-channel')).toBe(true);
 act(()=>socket.receive('disconnect','transport close'));
 expect(screen.queryByText('Ari')).toBeNull();expect(screen.queryByText('Sam')).toBeNull();
});

it('shows typing dots for a background DM, restores its avatar when opened, and clears on stop', async () => {
 const peer = {id:'maya', name:'Maya', image:'/maya.png', presence:'active'};
 const dm = {id:'maya-dm', workspace_id:'workspace', kind:'direct', name:peer.name, private:true, joined:true, participants:[peer]};
 vi.stubGlobal('fetch', vi.fn(async(path:string) => ({ok:true, status:200, json:async() => {
  if (path.startsWith('/v1/workspaces?')) return {items:[{id:'workspace',name:'Team'}],next_cursor:null};
  if (path.includes('/direct-messages?')) return {items:[dm],next_cursor:null};
  if (path === '/v1/channels/maya-dm') return dm;
  if (path.includes('/channels?')) return {items:[{id:'first',name:'general',joined:true,workspace_id:'workspace'}],next_cursor:null};
  if (isMessageHistory(path)) return messagePage();
  if (path.includes('/history')) return {events:[],cursor:'0',has_more:false};
  return [];
 }})));
 render(<Chat/>);
 const row = await screen.findByRole('button',{name:'Maya',exact:true});
 const socket = latestChatSocket();
 const event = {workspace_id:'workspace',channel_id:dm.id,thread_id:null,source_id:'tab',user:peer,active:true,expires_at:Date.now()+6000};
 const dots = () => within(row).queryByRole('img',{name:'Maya is typing'});
 act(() => socket.receive('workspace.dm-typing',{...event,thread_id:'thread'}));
 expect(dots()).toBeNull();
 act(() => socket.receive('workspace.dm-typing',event));
 expect(dots()?.querySelectorAll('circle')).toHaveLength(3);
 act(() => socket.receive('workspace.dm-typing',{...event,active:false}));
 expect(dots()).toBeNull();
 act(() => socket.receive('workspace.dm-typing',event));
 await userEvent.click(row);
 await screen.findByRole('textbox',{name:'Message Maya'});
 expect(dots()).toBeNull();
 expect(row.querySelector('img')?.getAttribute('src')).toBe('/maya.png');
});

it.each([false,true])('keeps the DM introduction before populated history only at its beginning: older=%s', async hasOlder => {
 const dm={id:'self',workspace_id:'workspace',kind:'direct',name:'Kai (you)',private:true,joined:true,participants:[{id:'user',name:'Kai',image:null,presence:'active'}],hidden:false,topic:'',description:'',archived_at:null};
 const note={...paginatedMessage('A saved personal note','1'),channel_id:'self'};
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>{
  if(path.startsWith('/v1/workspaces?'))return{items:[{id:'workspace',name:'Team'}],next_cursor:null};
  if(path.includes('/direct-messages?'))return{items:[dm],next_cursor:null};
  if(path==='/v1/channels/self')return dm;
  if(path.includes('/channels?'))return{items:[{id:'first',name:'general',joined:true,workspace_id:'workspace'}],next_cursor:null};
  if(isMessageHistory(path))return path.includes('/channels/self/')?messagePage([note],{has_older:hasOlder}):messagePage();
  if(path.includes('/history'))return{events:[],cursor:'0',has_more:false};
  return[];
 }})));
 render(<Chat/>);
 await userEvent.click(await screen.findByRole('button',{name:'Kai (you)',exact:true}));
 const content=await screen.findByText(note.text),list=screen.getByLabelText('Messages in Kai (you)');
 const intro=within(list).queryByText('Your space for notes, links, and files.');
 if(hasOlder)expect(intro).toBeNull();
 else{expect(intro).not.toBeNull();expect(intro!.compareDocumentPosition(content)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();}
});

it.each(['channel', 'workspace'] as const)('opens self DMs inside Home and preserves sidebar, drafts and navigation context: revoke=%s', async revokeScope => {
  const person = { id: 'user', name: 'Kai', image: '/kai.png', presence: 'active' };
  const dm = { id: 'self', workspace_id: 'workspace', kind: 'direct', name: 'Kai (you)', private: true, joined: true, participants: [person], hidden: false, topic: '', description: '', archived_at: null };
  let revoked = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/v1/channels/self' && revoked ? { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } : { ok: true, status: 200, json: async () => {
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
    if (path.includes('/direct-messages?')) return { items: [dm], next_cursor: null };
    if (path === '/v1/channels/self') return dm;
    if (path.includes('/channels?')) return { items: [{ id: 'first', name: 'general', joined: true, workspace_id: 'workspace' }], next_cursor: null };
    if (isMessageHistory(path)) return messagePage();
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } }));
  render(<Chat />);
  await screen.findByRole('textbox', { name: 'Message general' });
  const self = await screen.findByRole('button', { name: 'Kai (you)', exact: true });
  expect(self.querySelector('img')?.getAttribute('src')).toBe('/kai.png');
  await userEvent.click(self);
  const composer = await screen.findByRole('textbox', { name: 'Message Kai (you)' });
  expect(composer.getAttribute('data-placeholder')).toBe('Jot something down');
  expect(screen.getByRole('searchbox', { name: 'Find a conversation' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('searchbox', { name: 'Find a DM' })).toBeNull();
  await userEvent.type(composer, 'Keep this draft');
  await userEvent.click(screen.getByRole('button', { name: 'general', exact: true }));
  await screen.findByRole('textbox', { name: 'Message general' });
  await userEvent.click(screen.getByRole('button', { name: 'Back in history' }));
  expect((await screen.findByRole('textbox', { name: 'Message Kai (you)' })).textContent).toContain('Keep this draft');
  expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
  await userEvent.click(screen.getByRole('button', { name: 'DMs', exact: true }));
  await screen.findByRole('searchbox', { name: 'Find a DM' });
  await userEvent.click(screen.getByRole('link', { name: 'Home' }));
  await screen.findByRole('textbox', { name: 'Message Kai (you)' });
  revoked = true;
  await act(async () => { latestChatSocket().receive('updates.revoked', { scope: revokeScope, id: revokeScope === 'channel' ? 'self' : 'workspace', error: 'forbidden' }); });
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Message Kai (you)' })).toBeNull());
  expect(localStorage.getItem('space:composer-drafts:user') ?? '').not.toContain('Keep this draft');
});

it('opens DMs from the rail and selects a recipient into the shared message room', async () => {
  const person = { id: 'alex', name: 'Alex', image: null, title: 'Designer', presence: 'active' };
  const dm = { id: 'direct', workspace_id: 'workspace', kind: 'direct', name: 'Alex', private: true, joined: true, participants: [person], hidden: false, last_message: null, topic: '', description: '', archived_at: null };
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => ({ ok: true, status: 200, json: async () => {
    if (path.startsWith('/v1/workspaces?')) return { items: [{ id: 'workspace', name: 'Team' }], next_cursor: null };
    if (path.includes('/direct-message-people')) return { items: [person], next_cursor: null };
    if (path.includes('/direct-messages')) return init?.method === 'POST' ? dm : { items: [], next_cursor: null };
    if (path === '/v1/channels/direct') return dm;
    if (path === '/v1/channels/second-direct') return { ...dm, id: 'second-direct', name: 'Sam' };
    if (path.endsWith('/mention-settings')) return { broadcast_permission: 'all', can_manage: false, paused_until: null };
    if (path.endsWith('/mentions')) return { items: [{ id: 'notice', channel_id: 'second-direct', channel_name: 'Sam', message_id: 'mentioned', author_name: 'Sam', text: 'Please check this DM', created_at: '2026-11-04T00:00:00Z' }], unread_count: 1, next_cursor: null };
    if (path.endsWith('/messages/mentioned')) return { ...paginatedMessage('Mentioned DM message', '1'), id: 'mentioned' };

    if (path.includes('/channels?')) return { items: [{ id: 'first', name: 'general', joined: true, workspace_id: 'workspace' }], next_cursor: null };
    if (isMessageHistory(path)) return messagePage();
    if (path.includes('/history')) return { events: [], cursor: '0', has_more: false };
    return [];
  } })));
  render(<Chat />);
  await screen.findByRole('textbox', { name: 'Message general' });
  await userEvent.click(screen.getByRole('button', { name: 'DMs', exact: true }));
  await userEvent.click((await screen.findAllByRole('button', { name: 'New message', exact: true }))[0]!);
  expect(screen.queryByRole('dialog')).toBeNull();
  const pending = await screen.findByRole('textbox', { name: 'Message new conversation' });
  await userEvent.type(pending, 'Draft before choosing Alex');
  await userEvent.click(await screen.findByRole('button', { name: /Alex Designer/ }));
  const directComposer = await screen.findByRole('textbox', { name: 'Message Alex' });
  expect(directComposer.textContent).toContain('Draft before choosing Alex');
  expect(screen.queryByRole('button', { name: /recording unavailable/ })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'More conversation actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Conversation details', exact: true }));
  const details = await screen.findByRole('dialog', { name: 'Alex' });
  expect(within(details).getByText('Only the participants in this conversation can read and send messages.')).toBeTruthy();
  await userEvent.click(within(details).getByRole('button', { name: 'Close dialog', exact: true }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Alex' })).toBeNull());
  expect(screen.queryByRole('button', { name: 'View channel members' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Memory', exact: true })).toBeNull();
  expect(screen.getByRole('button', { name: 'Close direct message' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Mentions (1 unread)' }));
  await userEvent.click(await screen.findByRole('button', { name: /Please check this DM/ }));
  await screen.findByRole('textbox', { name: 'Message Sam' });
  await screen.findByText('Mentioned DM message');
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('/channels/second-direct/messages/mentioned'))).toBe(true));
});

it('opens Activity from the rail and routes its notification to the source message', async () => {
  const message = paginatedMessage('Activity destination message', '1');
  mockPaginatedChat(() => messagePage([message]));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const path = String(args[0]);
    const notification = { id: '7', kind: 'mention', channel_id: 'first', channel_name: 'first', channel_kind: 'channel', message_id: message.id, thread_id: message.thread_id, author_name: 'Alex', text: 'Please review this', emoji: null, created_at: message.created_at, read_at: null, silent: false };
    if (path.includes('/notifications')) return new Response(JSON.stringify(args[1]?.method === 'PATCH' ? { read: true } : { items: [notification], unread_count: 1, next_cursor: null, latest_id: '7' }), { status: 200 });
    if (path === '/v1/channels/first') return new Response(JSON.stringify({ id:'first',workspace_id:'workspace',name:'first',kind:'channel',joined:true }),{status:200});
    if (path === `/v1/channels/first/messages/${encodeURIComponent(message.id)}`) return new Response(JSON.stringify(message),{status:200});
    return original(...args);
  });
  render(<Chat/>);await screen.findByRole('textbox',{name:'Message first'});
  await userEvent.click(await screen.findByRole('button',{name:'Activity (1 unread)',exact:true}));
  await userEvent.click(await screen.findByRole('button',{name:/Open notification from Alex/}));
  await screen.findByRole('dialog',{name:'Original message in #first'});
  expect(await screen.findByRole('textbox',{name:'Message first'})).toBeTruthy();
});

it('opens a public nonmember mention through the join screen before loading its source', async () => {
  const message = paginatedMessage('Public mention destination', '1');
  mockPaginatedChat(() => messagePage([message]));
  const original = vi.mocked(fetch).getMockImplementation()!;
  let joined = false;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const path = String(args[0]);
    const notification = { id:'8',kind:'mention',channel_id:'public',channel_name:'public',channel_kind:'channel',message_id:message.id,thread_id:message.thread_id,author_name:'Alex',text:'Please join this discussion',emoji:null,created_at:message.created_at,read_at:null,silent:true };
    if(path.includes('/notifications'))return new Response(JSON.stringify(args[1]?.method==='PATCH'?{read:true}:{items:[notification],unread_count:1,next_cursor:null,latest_id:'8'}),{status:200});
    if(path.includes('/channels?'))return new Response(JSON.stringify({items:[{id:'first',workspace_id:'workspace',name:'first',kind:'channel',joined:true,private:false},{id:'public',workspace_id:'workspace',name:'public',kind:'channel',joined,private:false}],next_cursor:null}),{status:200});
    if(path==='/v1/channels/public/join'){joined=true;return new Response(JSON.stringify({joined:true}),{status:200});}
    if(path==='/v1/channels/public')return new Response(JSON.stringify(joined?{id:'public',workspace_id:'workspace',name:'public',kind:'channel',joined:true}:{error:'not_found'}),{status:joined?200:404});
    if(path===`/v1/channels/public/messages/${encodeURIComponent(message.id)}`)return new Response(JSON.stringify(message),{status:200});
    return original(...args);
  });
  render(<Chat/>);await screen.findByRole('textbox',{name:'Message first'});
  await userEvent.click(await screen.findByRole('button',{name:'Activity (1 unread)',exact:true}));
  await userEvent.click(await screen.findByRole('button',{name:/Open notification from Alex/}));
  await userEvent.click(await screen.findByRole('button',{name:'Join channel',exact:true}));
  await screen.findByRole('dialog',{name:'Original message in #public'});
  expect(await screen.findByRole('textbox',{name:'Message public'})).toBeTruthy();
});

it('opens workspace search from a Home shortcut without leaving it', async () => {
  mockPaginatedChat(() => messagePage([paginatedMessage('Search destination', '1')]));
  render(<Chat />);
  await screen.findByText('Search destination');
  await userEvent.click(screen.getByRole('button', {name:'Threads',exact:true}));
  await screen.findByRole('heading',{name:'Threads',exact:true});
  await userEvent.click(screen.getByRole('button',{name:'Search Team ⌘ K',exact:true}));
  expect(await screen.findByRole('searchbox',{name:'Search messages'})).toBeTruthy();
});

it('does not return focus to the old reply trigger when switching from a thread to Files', async () => {
  mockPaginatedChat(() => messagePage([paginatedMessage('Source for Files', '1')]));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((...args) => String(args[0]).endsWith('/first/tabs')
    ? Promise.resolve(new Response(JSON.stringify({has_files:true,has_links:false,visibility:{}}))) : original(...args));
  render(<Chat />);
  await screen.findByText('Source for Files');
  const trigger = screen.getByRole('button', { name: 'Reply to Kai' });
  await userEvent.click(trigger);
  await screen.findByRole('region', { name: 'Thread', exact: true });
  const restored = vi.fn();
  trigger.addEventListener('focus', restored);
  const files = within(document.querySelector('main.chat-channel')!).getByRole('tab', { name: 'Files & links', exact: true });
  await userEvent.click(files);
  await screen.findByRole('searchbox', { name: 'Search filenames' });
  expect(restored).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search filenames' }));
});

function mockDestinationNavigation() {
  const root = {...paginatedMessage('Destination parent','1'),agent_sessions:[{id:'nav-session',title:'Navigation session',agent_name:'Codex'}]};
  mockPaginatedChat(() => messagePage([root]));
  const original=vi.mocked(fetch).getMockImplementation()!;
  const person={id:'user',name:'Kai',image:null,title:'',presence:'active'};
  const direct={id:'nav-dm',workspace_id:'workspace',kind:'direct',name:'Kai (you)',joined:true,participants:[person],hidden:false,last_message:null,topic:'',description:'',archived_at:null};
  const session={id:'nav-session',title:'Navigation session',workspace_id:'workspace',origin_thread_id:'thread',installation_id:'agent',managed:true,state:'active',owner_id:'user',created_by:'user',agent_name:'Codex',turn_count:0};
  vi.mocked(fetch).mockImplementation(async(...args)=>{
    const path=String(args[0]);
    const data=path==='/v1/agent-sessions/nav-session'?{session,turns:[],next_cursor:null}:path==='/v1/channels/nav-dm'?direct:path.includes('/direct-messages?')?{items:[direct],next_cursor:null}:(/\/notifications(?:\?|$)/).test(path)?{items:[],unread_count:0,next_cursor:null,latest_id:'0'}:undefined;
    return data===undefined?original(...args):new Response(JSON.stringify(data),{status:200});
  });
}
it('restores the open agent session and its unsent draft after leaving Home for Activity',async()=>{
  mockDestinationNavigation();render(<Chat/>);await screen.findByText('Destination parent');
  await userEvent.click(screen.getByRole('button',{name:'Agent session: Navigation session'}));
  await userEvent.type(await screen.findByRole('textbox',{name:'Message agent session'}),'Keep this session draft');
  await userEvent.click(screen.getByRole('button',{name:'Activity',exact:true}));
  await screen.findByRole('heading',{name:'Activity',exact:true});
  await userEvent.click(screen.getByRole('link',{name:'Home',exact:true}));
  expect((await screen.findByRole('textbox',{name:'Message agent session'})).textContent).toContain('Keep this session draft');
});
it('restores the selected DM after visiting another rail destination',async()=>{
  mockDestinationNavigation();render(<Chat/>);await screen.findByText('Destination parent');
  await userEvent.click(screen.getByRole('button',{name:'DMs',exact:true}));
  await userEvent.click(await screen.findByRole('button',{name:'Open DM with Kai (you)'}));
  await screen.findByRole('textbox',{name:'Message Kai (you)'});
  await userEvent.click(screen.getByRole('link',{name:'Home',exact:true}));
  await screen.findByText('Destination parent');
  await userEvent.click(screen.getByRole('button',{name:'DMs',exact:true}));
  await screen.findByRole('textbox',{name:'Message Kai (you)'});
});
it('restores Activity filters after visiting Home',async()=>{
  mockDestinationNavigation();render(<Chat/>);await screen.findByText('Destination parent');
  await userEvent.click(screen.getByRole('button',{name:'Activity',exact:true}));
  await userEvent.click(await screen.findByRole('tab',{name:'Mentions',exact:true}));
  await userEvent.click(screen.getByRole('checkbox',{name:'Unreads'}));
  await userEvent.click(screen.getByRole('link',{name:'Home',exact:true}));
  await screen.findByText('Destination parent');
  await userEvent.click(screen.getByRole('button',{name:'Activity',exact:true}));
  expect((await screen.findByRole('tab',{name:'Mentions',exact:true})).getAttribute('aria-selected')).toBe('true');
  expect((screen.getByRole('checkbox',{name:'Unreads'}) as HTMLInputElement).checked).toBe(true);
});
it('updates the Activity badge without rendering the current message history',async()=>{
  mocks.badgeOverride=true;mockDestinationNavigation();render(<Chat/>);await screen.findByText('Destination parent');
  await act(async()=>{});
  const before=mocks.timelineRenders;
  await act(async()=>{mocks.setBadge?.(3);});
  await screen.findByRole('button',{name:'Activity (3 unread)',exact:true});
  console.log('RENDER_BADGE',JSON.stringify({before,after:mocks.timelineRenders}));
  expect(mocks.timelineRenders).toBe(before);
});

it('updates incoming messages without replacing existing rows or the composer',async()=>{
 mockDestinationNavigation();render(<Chat/>);await screen.findByText('Destination parent');
 const existing=screen.getByText('Destination parent').closest('article'),editor=await screen.findByRole('textbox',{name:'Message first'});
 await act(async()=>{});const before=mocks.timelineRenders;
 const incoming=paginatedMessage('Incoming render check','2');
 await act(async()=>{latestChatSocket().receive('chat.events',{channel_id:'first',cursor:'2',events:[{type:'message.created',channel_id:'first',thread_id:incoming.thread_id,sequence:'2',occurred_at:incoming.created_at,payload:incoming}]},vi.fn());});
 await screen.findByText('Incoming render check');
 expect(screen.getByText('Destination parent').closest('article')).toBe(existing);expect(screen.getByRole('textbox',{name:'Message first'})).toBe(editor);
 console.log('RENDER_INCOMING',JSON.stringify({historyPasses:mocks.timelineRenders-before,existingRowReused:true,composerReused:true}));
});

it('uses the focused access layout with an announcement during the initial session check',()=>{
 mocks.authPending=true;const view=render(<Chat/>);
 expect(screen.getByRole('status').textContent).toContain('Opening your workspace…');
 expect(view.container.querySelector('.access-frame')).toBeTruthy();
});
it('uses the focused access layout while workspaces are loading',async()=>{
 let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>({ok:true,json:async()=>path.startsWith('/v1/workspaces?')?pending:[]})));
 const view=render(<Chat/>);
 expect((await screen.findByRole('status')).textContent).toContain('Loading workspaces…');
 expect(view.container.querySelector('.access-frame')).toBeTruthy();
 view.unmount();await act(async()=>{finish({items:[],next_cursor:null});await pending;});
});

it('searches the whole workspace from a hub and opens an older cross-channel message', async () => {
  mockPaginatedChat(() => messagePage([paginatedMessage('Latest message', '5')]));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const path = String(args[0]);
    if (path.includes('/channels?')) return new Response(JSON.stringify({ items: ['first', 'second'].map(id => ({id,name:id,workspace_id:'workspace',joined:true})), next_cursor:null }), {status:200});
    const result = path.includes('/workspace/search?') ? { items: [{ id: 'older', channel_id: 'second', channel_name: 'second', channel_kind: 'channel', thread_id: 'old-thread', is_reply: false, text: 'Older indexed message', author: { id: 'user', name: 'Kai' }, created_at: '2026-01-01T00:00:00Z' }], next_cursor: null } : path === '/v1/channels/second' ? { id: 'second', name: 'second', workspace_id: 'workspace', joined: true } : path.endsWith('/second/messages/older') ? { ...paginatedMessage('Freshly authorized old message', '1'), id: 'older', channel_id: 'second' } : undefined;
    return result ? new Response(JSON.stringify(result), { status: 200 }) : original(...args);
  });
  render(<Chat />);
  await screen.findByText('Latest message');
  await userEvent.click(screen.getByRole('button', { name: 'Threads', exact: true }));
  await screen.findByRole('heading', { name: 'Threads', exact: true });
  await userEvent.click(screen.getByRole('button', { name: 'Search Team ⌘ K', exact: true }));
  const dialog = await screen.findByRole('dialog', { name: 'Search workspace' });
  expect(screen.getByRole('heading', { name: 'Threads', exact: true })).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'older' } });
  fireEvent.submit(within(dialog).getByRole('searchbox').closest('form')!);
  await userEvent.click(await within(dialog).findByRole('button', { name: /Older indexed message/ }));
  const source = await screen.findByRole('dialog', { name: 'Original message in #second' });
  await within(source).findByText('Freshly authorized old message');
  const searchRequest = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/workspace/search?'));
  expect(String(searchRequest?.[0])).not.toContain('channel_id=');
});

it('opens an indexed reply outside loaded channel history with fresh source authorization', async () => {
  mockPaginatedChat(() => messagePage([paginatedMessage('Latest channel message', '5')]));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const path = String(args[0]);
    const result = path.includes('/workspace/search?') ? { items: [{ id: 'old-reply', channel_id: 'first', channel_name: 'first', channel_kind: 'channel', thread_id: 'old-thread', is_reply: true, text: 'Indexed old reply', author: { id: 'user', name: 'Kai' }, created_at: '2026-01-01T00:00:00Z' }], next_cursor: null } : path.endsWith('/first/messages/old-reply') ? { ...paginatedMessage('Authorized old reply', '1'), id: 'old-reply', channel_id: 'first' } : undefined;
    return result ? new Response(JSON.stringify(result), {status:200}) : original(...args);
  });
  render(<Chat />);
  await screen.findByText('Latest channel message');
  await userEvent.click(screen.getByRole('button', { name: 'Search in first' }));
  const dialog = await screen.findByRole('dialog', { name: 'Search in first' });
  fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'old' } });
  fireEvent.submit(within(dialog).getByRole('searchbox').closest('form')!);
  const results = await screen.findByRole('complementary', { name: 'Search results in first' });
  await userEvent.click(await within(results).findByRole('button', { name: /Indexed old reply/ }));
  const source = await screen.findByRole('region', { name: 'Original message in #first' });
  await within(source).findByText('Authorized old reply');
  expect(within(results).getByRole('button', {name:/Indexed old reply/}).getAttribute('aria-current')).toBe('true');
  await userEvent.click(within(source).getByRole('button', {name:'Open thread'}));
  expect(screen.getByRole('region', { name: 'Thread', exact: true })).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('channel_id=first'))).toBe(true);
});

it('selects multiple messages and opens a private sidekick handoff without posting to the channel',async()=>{
 const user=userEvent.setup();
 const rows=[paginatedMessage('First selected message','1'),paginatedMessage('Second selected message','2','another-thread')];
 const session={id:'private-session',channel_id:'self',workspace_id:'workspace',origin_thread_id:'private-thread',installation_id:'mine',title:'Selected messages',state:'active',managed:true,created_by:'user',owner_id:'user',agent_name:'My Codex',created_at:rows[0]!.created_at,skill:'codex.run',turn_count:0};
 const context={channel_id:'first',channel_name:'first',captured_at:rows[0]!.created_at,messages:rows.map(message=>({id:message.id,thread_id:message.thread_id,author:message.author.name,text:message.text,created_at:message.created_at,files:[]}))};
 mockPaginatedChat(()=>messagePage(rows));
 const fallback=vi.mocked(fetch).getMockImplementation()!;
 vi.mocked(fetch).mockImplementation(async(input,init)=>{
  const path=String(input);
  if(path.endsWith('/messages/'+encodeURIComponent(rows[1]!.id)))return Response.json(rows[1]);
  if(path.includes('/search?'))return Response.json({items:[{...rows[1],channel_name:'first',channel_kind:'channel',is_reply:true}],next_cursor:null});
  if(path.endsWith('/sidekick-agents'))return {ok:true,json:async()=>[{id:'mine',name:'My Codex',owner_id:'user',enabled:true,capabilities:{skills:['codex.run'],persistent_sessions:true}}]} as Response;
  if(path.endsWith('/sidekick-sessions'))return {ok:true,json:async()=>init?.method==='POST'?session:{items:[],next_cursor:null}} as Response;
  if(path==='/v1/agent-sessions/private-session')return {ok:true,json:async()=>({session,context,turns:[],next_cursor:null})} as Response;
  return fallback(input,init);
 });
 render(<Chat/>);await screen.findByText(rows[0]!.text, {}, { timeout: 5000 });
 await user.click(screen.getByText(rows[0]!.text));
 expect(screen.queryByRole('region',{name:'Selected messages'})).toBeNull();
 await user.keyboard('{Meta>}');
 await user.click(screen.getByText(rows[0]!.text));
 await user.keyboard('{/Meta}');
 expect(screen.getByRole('button',{name:/Select message from Kai: First selected/}).getAttribute('aria-pressed')).toBe('true');
 expect(screen.queryByRole('checkbox')).toBeNull();
 const secondSelection=screen.getByRole('button',{name:/Select message from Kai: Second selected/});
 await user.click(secondSelection);
 expect(secondSelection.getAttribute('aria-pressed')).toBe('true');
 await user.keyboard(' ');
 expect(secondSelection.getAttribute('aria-pressed')).toBe('false');
 await user.keyboard('{Enter}');
 expect(secondSelection.getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByText('2 selected')).toBeTruthy();
 await user.click(within(screen.getByRole('region',{name:'Selected messages'})).getByRole('button',{name:'Discuss with agent'}));
 const panel=await screen.findByRole('region',{name:'My sidekick'});
 await within(panel).findByRole('heading',{name:'My Codex',exact:true,level:1});
 const contextSection=await within(panel).findByRole('region',{name:'Selected messages'});
 expect(within(contextSection).getByText(rows[0]!.text)).toBeTruthy();
 expect(within(contextSection).getByText(rows[1]!.text)).toBeTruthy();
 expect(within(panel).getByRole('log',{name:'Session conversation'}).contains(contextSection)).toBe(true);
 expect(screen.queryByRole('dialog',{name:'Selected messages'})).toBeNull();
 const creates=vi.mocked(fetch).mock.calls.filter(([path,init])=>String(path).endsWith('/sidekick-sessions')&&init?.method==='POST');
 expect(creates).toHaveLength(1);
 expect(JSON.parse(String(creates[0]![1]?.body))).toMatchObject({installation_id:'mine',source:{channel_id:'first',message_ids:rows.map(row=>row.id)}});
 expect(vi.mocked(fetch).mock.calls.some(([path,init])=>String(path).endsWith('/messages')&&init?.method==='POST')).toBe(false);
 expect(latestChatSocket().requests.some((request:any)=>request.name==='message.send')).toBe(false);
 await user.click(screen.getByRole('button',{name:'Search in first'}));
 await user.type(screen.getByRole('searchbox',{name:'Search messages'}),'selected{Enter}');
 await user.click(await screen.findByRole('button',{name:/Second selected message.*Thread reply/}));
 await user.click(await within(await screen.findByRole('region',{name:'Original message in #first'})).findByRole('button',{name:'Open thread'}));
 expect(screen.queryByRole('region',{name:'My sidekick'})).toBeNull();
 expect(screen.getByRole('region',{name:'Thread'})).toBeTruthy();
 expect(screen.queryByRole('checkbox')).toBeNull();
});

it('keeps the thread header free of the sidekick handoff action',async()=>{
 const root=paginatedMessage('Whole thread source','1');mockPaginatedChat(()=>messagePage([root],{has_older:true}));
 render(<Chat/>);await screen.findByText(root.text);
 await userEvent.click(screen.getByRole('button',{name:'Reply to Kai'}));
 const thread=await screen.findByRole('region',{name:'Thread',exact:true});
 expect(within(thread).queryByRole('button',{name:'Discuss with agent'})).toBeNull();
 expect(within(thread).getByRole('button',{name:'Close thread'})).toBeTruthy();
});

it('opens agent sessions below direct messages, retains drafts, and refreshes sidebar entries from workspace events',async()=>{
 const user=userEvent.setup();
 mockPaginatedChat(()=>messagePage([paginatedMessage('Channel source','1')]));
 const fallback=vi.mocked(fetch).getMockImplementation()!;
 let session={working:false,id:'00000000-0000-4000-8000-000000000001',channel_id:'first',channel_archived:false,workspace_id:'workspace',origin_thread_id:'session-thread',installation_id:'mine',title:'Launch checklist',state:'active',managed:true,created_by:'user',owner_id:'user',agent_name:'My Codex',created_at:'2026-11-04T00:00:00Z',skill:'codex.run',turn_count:0};
 let items=[session];
 vi.mocked(fetch).mockImplementation(async(input,init)=>{
  const path=String(input);
  if(path==='/v1/workspaces/workspace/agent-sessions')return {ok:true,json:async()=>({items,next_cursor:null})} as Response;
  if(path===`/v1/agent-sessions/${session.id}` && init?.method==='PATCH'){
   const edit=JSON.parse(String(init.body));
   expect(edit.previous_title).toBe(session.title);
   session={...session,title:edit.title};items=[session];
   return {ok:true,json:async()=>session} as Response;
  }
  if(path===`/v1/agent-sessions/${session.id}`)return {ok:true,json:async()=>({session,turns:[],next_cursor:null})} as Response;
  if(path===`/v1/agent-sessions/${session.id}/location`)return {ok:true,json:async()=>session} as Response;
  return fallback(input,init);
 });
 const mounted=render(<Chat/>);
 const nav=await screen.findByRole('navigation',{name:'Workspace conversations'});
 const entry=await within(nav).findByRole('button',{name:'Launch checklist',exact:true});
 const headings=within(nav).getAllByRole('button').map(button=>button.textContent);
 expect(headings.indexOf('Agent sessions')).toBeGreaterThan(headings.indexOf('Direct messages'));
 expect(headings.indexOf('Agent sessions')).toBeLessThan(headings.indexOf('Apps'));
 const updateActivity=async(working:boolean)=>{
  items=[{...session,working}];
  await act(async()=>{latestChatSocket().receive('updates.changed',{scope:'workspace',id:'workspace'});});
 };
 await updateActivity(true);
 await within(entry).findByRole('img',{name:'My Codex is working'});
 await updateActivity(false);
 await waitFor(()=>expect(within(entry).queryByRole('img',{name:'My Codex is working'})).toBeNull());
 fireEvent.contextMenu(entry);
 await user.click(await screen.findByRole('menuitem',{name:'Rename…'}));
 const rename=within(await screen.findByRole('dialog',{name:'Rename session'}));
 const title=rename.getByRole('textbox',{name:'Session title'});
 await user.clear(title);
 expect((rename.getByRole('button',{name:'Save'}) as HTMLButtonElement).disabled).toBe(true);
 await user.type(title,'Launch plan');
 await user.click(rename.getByRole('button',{name:'Save'}));
 await within(nav).findByRole('button',{name:'Launch plan',exact:true});
 expect(entry.getAttribute('aria-current')).toBeNull();
 await user.click(entry);
 expect(entry.getAttribute('aria-current')).toBe('page');
 await screen.findByRole('heading',{name:'My Codex',exact:true,level:1});
 await updateActivity(true);
 expect(within(entry).queryByRole('img',{name:'My Codex is working'})).toBeNull();
 await updateActivity(false);
 await user.type(await screen.findByRole('textbox',{name:'Message agent session'}),'Remember this draft');
 await user.click(screen.getByRole('button',{name:'Rename session'}));
 const headerRename=within(await screen.findByRole('dialog',{name:'Rename session'}));
 const headerTitle=headerRename.getByRole('textbox',{name:'Session title'});
 expect((headerTitle as HTMLInputElement).value).toBe('Launch plan');
 await user.clear(headerTitle);
 await user.type(headerTitle,'Launch checklist');
 await user.click(headerRename.getByRole('button',{name:'Save'}));
 await within(nav).findByRole('button',{name:'Launch checklist',exact:true});
 await user.click(within(nav).getByRole('button',{name:'first',exact:true}));
 await screen.findByRole('textbox',{name:'Message first'});
 await user.click(entry);
 expect((await screen.findByRole('textbox',{name:'Message agent session'})).textContent).toContain('Remember this draft');
 items=[{...session,id:'second-session',title:'New discussion'},session];
 await act(async()=>{for(const socket of mocks.sockets)socket.receive('updates.changed',{scope:'workspace',id:'workspace'});});
 expect(await within(nav).findByRole('button',{name:'New discussion',exact:true})).toBeTruthy();
 await user.type(screen.getByRole('searchbox',{name:'Find a conversation'}),'Launch');
 expect(within(nav).queryByRole('button',{name:'New discussion',exact:true})).toBeNull();
 expect(within(nav).getByRole('button',{name:'Launch checklist',exact:true})).toBeTruthy();
 const link=location.pathname;
 expect(link).toBe('/s/AAAAAAAAQACAAAAAAAAAAQ');
 mounted.unmount();
 window.history.replaceState(null,'',link);
 items=[];
 render(<Chat/>);
 await screen.findByRole('textbox',{name:'Message agent session'});
 expect(location.pathname).toBe(link);
});

it('applies live post and reply capabilities independently without losing either draft', async () => {
  const root = paginatedMessage('Permission thread', '1');
  mockPaginatedChat(() => messagePage([root]), '1');
  render(<Chat />);
  const draft = await screen.findByRole('textbox', { name: 'Message first' });
  await userEvent.type(draft, 'Keep channel draft');
  await userEvent.click(screen.getByRole('button', { name: 'Reply to Kai' }));
  const thread = screen.getByRole('region', { name: 'Thread', exact: true });
  const reply = await within(thread).findByRole('textbox', { name: 'Message thread' });
  await userEvent.type(reply, 'Keep thread draft');
  mocks.channelPost = false;
  await act(async () => { latestChatSocket().receive('updates.changed', { scope: 'channel', id: 'first' }); });
  await screen.findByText('You can read this channel, but posting is restricted.');
  expect(screen.getByRole('textbox', { name: 'Message first' })).toBe(draft);
  expect(draft.textContent).toContain('Keep channel draft');
  expect(within(thread).getByRole('textbox', { name: 'Message thread' })).toBe(reply);
  expect(within(thread).queryByText('You can read this thread, but replies are restricted.')).toBeNull();
  mocks.channelPost = true; mocks.channelReply = false;
  await act(async () => { latestChatSocket().receive('updates.changed', { scope: 'workspace', id: 'workspace' }); });
  await within(thread).findByText('You can read this thread, but replies are restricted.');
  expect(screen.queryByText('You can read this channel, but posting is restricted.')).toBeNull();
  expect(reply.textContent).toContain('Keep thread draft');
  mocks.permissionsError = true;
  await act(async () => { latestChatSocket().receive('updates.changed', { scope: 'channel', id: 'first' }); });
  await waitFor(() => expect(screen.getAllByText(/Unable to check channel permissions/)).toHaveLength(2));
  expect(draft.textContent).toContain('Keep channel draft');
  expect(reply.textContent).toContain('Keep thread draft');
});

it('confirms deletion of an owned thread reply, retains it on failure and replaces it on success', async () => {
  const user = userEvent.setup();
  const root = { ...paginatedMessage('Original question', '1'), reply_count: 1, author: { kind: 'human' as const, id: 'maya', name: 'Maya' } };
  const reply = { ...paginatedMessage('My reply', '2'), thread_root_id: root.id };
  mockPaginatedChat(path => messagePage(path.includes('/threads/') ? [root, reply] : [root]));
  const fallback = vi.mocked(fetch).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method !== 'DELETE') return fallback(input, init);
    expect(String(input)).toBe('/v1/channels/first/messages/' + reply.id);
    attempts++;
    return attempts === 1 ? { ok: false, json: async () => ({ error: 'temporarily_unavailable' }) } as Response
      : { ok: true, json: async () => ({ ...reply, text: '', deleted_at: '2026-11-09T00:00:00Z' }) } as Response;
  });
  render(<Chat />);
  await screen.findByText(root.text);
  await user.click(screen.getByLabelText('More actions'));
  expect(screen.queryByRole('menuitem', { name: /Delete message/ })).toBeNull();
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: /1 reply View thread/ }));
  const panel = within(await screen.findByRole('region', { name: 'Thread', exact: true }));
  const row = (await panel.findByText(reply.text)).closest('article')!;
  const open = async () => {
    await user.click(within(row).getByLabelText('More actions'));
    await user.click(screen.getByRole('menuitem', { name: /Delete message/ }));
    return within(screen.getByRole('dialog', { name: 'Delete message?' }));
  };
  await user.click((await open()).getByRole('button', { name: 'Cancel' }));
  expect(attempts).toBe(0);
  expect(toast.getState().toasts.some(item => item.title === 'Message deleted')).toBe(false);
  const dialog = await open();
  await user.click(dialog.getByRole('button', { name: 'Delete message' }));
  expect((await dialog.findByRole('alert')).textContent).toContain('temporarily unavailable');
  expect(within(row).getByText(reply.text)).toBeTruthy();
  expect(toast.getState().toasts.some(item => item.title === 'Message deleted')).toBe(false);
  await user.click(dialog.getByRole('button', { name: 'Delete message' }));
  await panel.findByText('This message was deleted.');
  expect(toast.getState().toasts.at(-1)).toMatchObject({ type: 'success', title: 'Message deleted' });
  expect(panel.queryByText(reply.text)).toBeNull();
  expect(within(row).queryByLabelText('More actions')).toBeNull();
  expect(screen.getByRole('button', { name: /1 reply View thread/ })).toBeTruthy();
});

it('keeps a deleted DM root and its thread link in place after reconnect replay', async () => {
  const dm = { id: 'self', workspace_id: 'workspace', kind: 'direct', name: 'Kai (you)', private: true, joined: true, participants: [{ id: 'user', name: 'Kai' }], archived_at: null };
  const root = { ...paginatedMessage('A private note', '1'), id: 'root', channel_id: dm.id, thread_root_id: 'root', reply_count: 1 };
  const deleted = { ...root, text: 'Message deleted', deleted_at: '2026-11-09T00:00:00Z', reaction_sequence: '3' };
  const reply = { ...paginatedMessage('A follow-up', '2'), channel_id: dm.id, thread_root_id: 'root' };
  mockPaginatedChat(path => messagePage(path.includes('/threads/') ? [deleted, reply] : path.includes('/self/') ? [root] : []));
  const fallback = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).includes('/direct-messages?')) return { ok: true, json: async () => ({ items: [dm], next_cursor: null }) } as Response;
    if (String(input) === '/v1/channels/self') return { ok: true, json: async () => dm } as Response;
    return fallback(input, init);
  });
  render(<Chat />);
  await userEvent.click(await screen.findByRole('button', { name: dm.name, exact: true }));
  const row = (await screen.findByText(root.text)).closest('article')!;
  await userEvent.click(within(row).getByLabelText('More actions'));
  await userEvent.click(screen.getByRole('menuitem', { name: /Delete message/ }));
  expect(screen.getByRole('dialog', { name: 'Delete message?' })).toBeTruthy();
  const event = (type: string, sequence: string, payload: ChatMessage) => ({ type, sequence, payload, channel_id: dm.id, thread_id: root.thread_id, occurred_at: root.created_at });
  await act(async () => { latestChatSocket().receive('chat.events', { channel_id: dm.id, cursor: '3', events: [
    event('message.updated', '3', deleted), event('message.created', '1', root),
  ] }, vi.fn()); });
  expect(screen.queryByRole('dialog', { name: 'Delete message?' })).toBeNull();
  expect(within(row).queryByLabelText('More actions')).toBeNull();
  expect(within(row).queryByText(root.text)).toBeNull();
  expect(within(row).getByText('This message was deleted.')).toBeTruthy();
  await userEvent.click(within(row).getByRole('button', { name: /1 reply View thread/ }));
  const thread = within(await screen.findByRole('region', { name: 'Thread', exact: true }));
  await thread.findByText(reply.text);
  expect(thread.getByText('This message was deleted.')).toBeTruthy();
});

it('opens integrations for a sidebar channel while the active conversation stays selected', async () => {
  const builds = {id:'builds',name:'builds',joined:true,workspace_id:'workspace',member_count:1,created_at:'2026-11-10T00:00:00Z'};
  vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok:true, status:200, json:async () => {
    if (path.startsWith('/v1/workspaces?')) return {items:[{id:'workspace',name:'Team'}],next_cursor:null};
    if (path.includes('/channels?')) return {items:[{...builds,id:'general',name:'general'},builds],next_cursor:null};
    if (path === '/v1/channels/builds') return builds;
    if (path.endsWith('/permissions')) return {capabilities:{post:true,reply:true,manage:true},manager_ids:[]};
    if (path.endsWith('/webhooks')) return [];
    if (path.endsWith('/navigator')) return {candidates:[]};
    if (isMessageHistory(path)) return messagePage();
    if (path.includes('/history')) return {events:[],cursor:'0',has_more:false};
    return {items:[],next_cursor:null};
  }})));
  render(<Chat />);
  const composer = await screen.findByRole('textbox',{name:'Message general'});
  fireEvent.contextMenu(screen.getByRole('button',{name:'builds',exact:true}));
  await userEvent.click(await screen.findByRole('menuitem',{name:'Channel details'}));
  const modal = await screen.findByRole('dialog',{name:'# builds'});
  await userEvent.click(within(modal).getByRole('tab',{name:'Agents & apps'}));
  await within(modal).findByText('No agents or apps have been added to this channel.');
  await userEvent.click(within(modal).getByRole('button',{name:'Manage'}));
  await within(modal).findByRole('button',{name:'Create incoming webhook'});
  expect(composer.isConnected).toBe(true);
  expect(screen.getByRole('button',{name:'general',exact:true,hidden:true}).getAttribute('aria-current')).toBe('page');
});
