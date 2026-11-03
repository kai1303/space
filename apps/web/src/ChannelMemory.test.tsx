import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelMemory } from './ChannelMemory.js';
vi.mock('./MemoryConnections.js', () => ({ MemoryConnections: () => null }));

const empty = { content: '', revision: 'a'.repeat(64), sources: [] };
const state = (enabled = false, can_manage = true) => ({ enabled, can_manage, provider: 'markdown', providers: [{ id: 'markdown', name: 'Markdown files' }], document: enabled ? empty : null });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('requires opt-in before saving a message, then saves and edits Markdown', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith('/settings')) return response(state(true));
    if (path.endsWith('/sources')) return response({ ...empty, content: '> Use PostgreSQL.', revision: 'b'.repeat(64) });
    if (path.endsWith('/document')) return response({ ...empty, content: JSON.parse(options!.body as string).content, revision: 'c'.repeat(64) });
    return response(state());
  }));
  render(<ChannelMemory channel="first" name="general" open message={{ id: 'message', text: 'Use PostgreSQL.' }} onClose={() => {}} />);
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
  render(<ChannelMemory channel="first" name="general" open onClose={() => {}} />);
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
  render(<ChannelMemory channel="first" name="general" open onClose={() => {}} />);
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
  const view = render(<ChannelMemory channel="first" name="first" open onClose={() => {}} />);
  view.rerender(<ChannelMemory channel="second" name="second" open onClose={() => {}} />);
  await screen.findByText('Memory is off for this channel.');
  await act(async () => finish(response({ ...state(true), document: { ...empty, content: 'Private first channel' } })));
  expect(screen.queryByDisplayValue('Private first channel')).toBeNull();
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/document') ? response({ error: 'not_found' }, 404) : response(state(true))));
  view.rerender(<ChannelMemory channel="third" name="third" open onClose={() => {}} />);
  const editor = await screen.findByRole('textbox', { name: 'Channel memory Markdown' });
  fireEvent.change(editor, { target: { value: 'Private draft' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Channel memory Markdown' })).toBeNull());
  expect(screen.getByRole('alert').textContent).toContain('not found');
});

it('lets the user cancel closing a dirty editor', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(state(true))));
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    render(<ChannelMemory channel="first" name="general" open onClose={() => {}} />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Channel memory Markdown' }), { target: { value: 'Unsaved decision' } });
    const navigation = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(navigation);
    expect(navigation.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(confirmation).toHaveBeenCalled();
    expect((screen.getByRole('dialog') as HTMLDialogElement).open).toBe(true);
  } finally { confirmation.mockRestore(); }
});

it('animates deletion confirmation away and disables its actions as soon as Cancel is clicked', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(state(true))));
  render(<ChannelMemory channel="first" name="general" open onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete stored memory…' }));
  const confirm = screen.getByRole('button', { name: 'Confirm delete memory' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
  expect(confirm.isConnected).toBe(true);
  expect(confirm.closest('[inert]')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm delete memory' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Delete stored memory…' })).toBeTruthy();
  await waitFor(() => expect(confirm.isConnected).toBe(false));
});
