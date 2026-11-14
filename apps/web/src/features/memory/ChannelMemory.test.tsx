import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelMemory } from './ChannelMemory.js';
let refreshMemory: () => Promise<void>;
vi.mock('../../shared/realtime/live-updates.js', () => ({
  subscribeUpdates: (_scope: string, _id: string, read: () => Promise<void>) => {
    refreshMemory = read; void read(); return () => {};
  },
}));
vi.mock('./MemoryConnections.js', () => ({ MemoryConnections: () => null }));
vi.mock('./MemoryGraph.js', () => ({ MemoryGraph: () => null }));
vi.mock('./MemoryInspector.js', () => ({ MemoryInspector: () => null }));
// The Memory tab opens on the Graph view; the notes tests switch to Notes first.
const notes = async () => userEvent.click(await screen.findByRole('tab', { name: 'Notes' }));

const empty = { content: '', revision: 'a'.repeat(64), sources: [] };
const state = (enabled = false, can_manage = true) => ({ enabled, can_manage, provider: 'markdown', providers: [{ id: 'markdown', name: 'Markdown files' }], document: enabled ? empty : null });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('requires opt-in before saving a message, then saves and edits Markdown', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith('/settings')) return response(state(true));
    if (path.endsWith('/sources')) return response({ ...empty, content: '> Use PostgreSQL.', revision: 'b'.repeat(64) });
    if (path.endsWith('/document')) return response({ ...empty, content: JSON.parse(options!.body as string).content, revision: 'c'.repeat(64) });
    return response(state());
  }));
  render(<ChannelMemory channel="first" name="general" message={{ id: 'message', text: 'Use PostgreSQL.' }} />);
  await screen.findByText('Memory is off for this channel.');
  expect(screen.queryByRole('textbox', { name: 'Channel memory Markdown' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Enable memory' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Save message to memory' }));
  const editor = await screen.findByRole('textbox', { name: 'Channel memory Markdown' });
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain('PostgreSQL'));
  fireEvent.change(editor, { target: { value: '# Decision\nUse PostgreSQL.' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText('Memory saved.');
  const call = vi.mocked(fetch).mock.calls.find(([path]) => String(path).endsWith('/document'))!;
  expect(JSON.parse(call[1]!.body as string).revision).toBe('b'.repeat(64));
});

it('keeps edits on conflict and loads latest for comparison without replacing the draft', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/document') ? response({ error: 'memory_conflict' }, 409)
    : response({ ...state(true), document: { ...empty, content: ++reads > 1 ? 'Another member’s update' : 'Original' } })));
  render(<ChannelMemory channel="first" name="general" />);
  await notes();
  const editor = await screen.findByRole('textbox', { name: 'Channel memory Markdown' });
  fireEvent.change(editor, { target: { value: 'My changes' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText(/Memory changed.*draft is kept/);
  expect((editor as HTMLTextAreaElement).value).toBe('My changes');
  await userEvent.click(screen.getByRole('button', { name: 'Load latest for comparison' }));
  await screen.findByText('Another member’s update');
  expect((editor as HTMLTextAreaElement).value).toBe('My changes');
});

it('imports a text document with a stable ID and keeps settings manager-only', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/sources') ? response({ ...empty, content: '# Runbook' }) : response(state(true, false))));
  render(<ChannelMemory channel="first" name="general" />);
  await notes();
  await screen.findByRole('textbox', { name: 'Channel memory Markdown' });
  expect(screen.queryByRole('button', { name: 'Disable memory' })).toBeNull();
  const file = new File(['# Runbook'], 'runbook.md', { type: 'text/markdown' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('# Runbook').buffer });
  fireEvent.change(screen.getByLabelText('Choose a memory document'), { target: { files: [file] } });
  await userEvent.click(await screen.findByRole('button', { name: 'Import document' }));
  await screen.findByText('Document added to memory.');
  const call = vi.mocked(fetch).mock.calls.find(([path]) => String(path).endsWith('/sources'))!;
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({ name: 'runbook.md', content: '# Runbook', source_id: expect.any(String) });
});

it('ignores a previous channel response after navigation and clears memory on denied access', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.includes('/first/') ? new Promise(resolve => { finish = resolve; }) : response(state())));
  const view = render(<ChannelMemory channel="first" name="first" />);
  view.rerender(<ChannelMemory channel="second" name="second" />);
  await notes();
  await screen.findByText('Memory is off for this channel.');
  await act(async () => finish(response({ ...state(true), document: { ...empty, content: 'Private first channel' } })));
  expect(screen.queryByDisplayValue('Private first channel')).toBeNull();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/document') ? response({ error: 'not_found' }, 404) : response(state(true))));
  view.rerender(<ChannelMemory channel="third" name="third" />);
  await notes();
  const editor = await screen.findByRole('textbox', { name: 'Channel memory Markdown' });
  fireEvent.change(editor, { target: { value: 'Private draft' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Channel memory Markdown' })).toBeNull());
  expect(screen.getByRole('alert').textContent).toContain('not found');
});

it('reports unsaved edits so the channel can ask before leaving the Memory tab', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(state(true))));
  const dirty = vi.fn();
  const view = render(<ChannelMemory channel="first" name="general" onDirtyChange={dirty} />);
  await notes();
  fireEvent.change(await screen.findByRole('textbox', { name: 'Channel memory Markdown' }), { target: { value: 'Unsaved decision' } });
  expect(dirty).toHaveBeenLastCalledWith(true);
  const navigation = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(navigation);
  expect(navigation.defaultPrevented).toBe(true);
  view.unmount();
  expect(dirty).toHaveBeenLastCalledWith(false);
});

it('shows as a channel tab panel and moves to Notes when a message is saved while open', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(state(true))));
  const view = render(<ChannelMemory asTab channel="first" name="general" />);
  expect(screen.getByRole('tabpanel', { name: 'Memory in #general' }).id).toBe('channel-memory');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe('true');
  view.rerender(<ChannelMemory asTab channel="first" name="general" message={{ id: 'message', text: 'Use PostgreSQL.' }} />);
  expect((await screen.findByRole('tab', { name: 'Notes' })).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('button', { name: 'Save message to memory' })).toBeTruthy();
});

it('animates deletion confirmation away and disables its actions as soon as Cancel is clicked', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(state(true))));
  render(<ChannelMemory channel="first" name="general" />);
  await notes();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete stored memory…' }));
  const confirm = screen.getByRole('button', { name: 'Confirm delete memory' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
  expect(confirm.isConnected).toBe(true);
  expect(confirm.closest('[inert]')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm delete memory' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Delete stored memory…' })).toBeTruthy();
  await waitFor(() => expect(confirm.isConnected).toBe(false));
});

it('opens on the graph view by default and switches to notes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(state(true))));
  render(<ChannelMemory channel="first" name="general" />);
  expect((await screen.findByRole('tab', { name: 'Graph' })).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tabpanel', { name: 'Graph' })).toBeTruthy();
  await notes();
  expect(await screen.findByRole('tabpanel', { name: 'Notes' })).toBeTruthy();
});

it('refreshes saved quotes and keeps an unsaved draft when its evidence changes', async () => {
  let content = 'Friday';
  vi.stubGlobal('fetch', vi.fn(async () => response({...state(true), document:{...empty, content, revision:content}})));
  render(<ChannelMemory channel="first" name="general" />);
  await notes();
  const editor = await screen.findByRole('textbox', { name: 'Channel memory Markdown' }) as HTMLTextAreaElement;
  content = 'Monday';
  await act(() => refreshMemory());
  expect(editor.value).toBe('Monday');
  fireEvent.change(editor, {target:{value:'My changes'}});
  content = '';
  await act(() => refreshMemory());
  expect(editor.value).toBe('My changes');
  expect(screen.getByRole('button', {name:'Load latest for comparison'})).toBeTruthy();
});

it('shows the selected message and keeps both tabs available while Notes loads', async () => {
  let finish!: (result: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  render(<ChannelMemory channel="first" name="general" message={{ id: 'message', text: 'Keep this decision.' }} />);
  expect(screen.getByText('Keep this decision.')).toBeTruthy();
  expect(screen.getByText('Loading channel memory…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save message to memory' })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
  expect(screen.queryByText('Loading channel memory…')).toBeNull();
  await notes();
  await act(async () => finish(Response.json(state(true))));
  expect(screen.getByRole('button', { name: 'Save message to memory' })).toBeTruthy();
  expect(screen.queryByText('Loading channel memory…')).toBeNull();
});

it('keeps the editor usable during a search and drops results for a changed query', async () => {
  let finish!: (result: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.includes('/search?')
    ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(state(true))));
  render(<ChannelMemory channel="first" name="general" />);
  await notes();
  const search = screen.getByRole('textbox', { name: 'Search saved memory' });
  fireEvent.change(search, { target: { value: 'old' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search memory' }));
  const editor = screen.getByRole('textbox', { name: 'Channel memory Markdown' }) as HTMLTextAreaElement;
  expect(editor.disabled).toBe(false);
  fireEvent.change(editor, { target: { value: 'My draft' } });
  fireEvent.change(search, { target: { value: 'new' } });
  await act(async () => finish(Response.json({ items: [{ line: 1, text: 'Old result' }] })));
  expect(editor.value).toBe('My draft');
  expect(screen.queryByText('Old result')).toBeNull();
});
