import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CollectionRailPreview } from './CollectionRailPreview.js';

const realtime = vi.hoisted(() => ({ revoke: (_code: string) => {}, close: vi.fn() }));
vi.mock('../../../shared/realtime/live-updates.js', () => ({
  subscribeUpdates: (_scope: string, _id: string, refresh: () => Promise<void>, revoke: (code: string) => void) => {
    realtime.revoke = revoke;
    void refresh();
    return realtime.close;
  },
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const file = { id: 'file-1', filename: 'Plan.pdf', channel_name: 'Planning', channel_id: 'channel', message_id: 'message', created_at: '2026-11-09T10:00:00Z', starred: false };
const todo = { id: 'todo-1', title: 'Review the plan', channel_id: 'channel', message_id: 'message', updated_at: file.created_at, completed: false, archived: false, deleted: false };
const props = { workspace: 'team', onOpen: vi.fn(), onOpenDestination: vi.fn() };

function respond(handler: (url: URL, init: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => ({
    ok: true, json: async () => handler(new URL(path, 'http://localhost'), init),
  })));
}

it('filters files server-side, stars a file explicitly and opens its source', async () => {
  let starred = false;
  respond((url, init) => {
    if (url.pathname.endsWith('/star')) { starred = JSON.parse(String(init.body)).active; return { starred }; }
    return { items: url.searchParams.get('starred') === 'true' && !starred ? [] : [{ ...file, starred }], next_cursor: null };
  });
  render(<CollectionRailPreview {...props} view="files"/>);
  await screen.findByText(file.filename);
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Starred' }));
  await screen.findByText('No starred files yet.');
  await userEvent.click(screen.getByRole('button', { name: 'Starred' }));
  await userEvent.click(await screen.findByRole('button', { name: 'More actions for Plan.pdf' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Star file' }));
  expect(starred).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Starred' }));
  await userEvent.click(await screen.findByRole('button', { name: 'View Plan.pdf in Planning' }));
  expect(props.onOpen).toHaveBeenCalledWith({ channel_id: 'channel', message_id: 'message' });
});

it('reads open to-dos and completes the version the user saw', async () => {
  let completed = false;
  respond((url, init) => {
    if (init.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ completed: true, expected_updated_at: todo.updated_at });
      completed = true;
      return { ...todo, completed };
    }
    expect(url.searchParams.get('status')).toBe('open');
    return { items: completed ? [] : [todo], next_cursor: null };
  });
  render(<CollectionRailPreview {...props} view="todos"/>);
  await userEvent.click(await screen.findByRole('button', { name: todo.title }));
  expect(props.onOpen).toHaveBeenCalledWith({ channel_id: 'channel', message_id: 'message' });
  await userEvent.click(screen.getByRole('checkbox', { name: 'Mark Review the plan complete' }));
  await screen.findByText('You checked everything off your list.');
});

it('removes private file rows on revocation and releases the listener on unmount', async () => {
  respond(() => ({ items: [file], next_cursor: null }));
  const view = render(<CollectionRailPreview {...props} view="files"/>);
  await screen.findByText(file.filename);
  act(() => realtime.revoke('forbidden'));
  expect(screen.queryByText(file.filename)).toBeNull();
  expect(screen.getByRole('alert')).toBeTruthy();
  view.unmount();
  expect(realtime.close).toHaveBeenCalled();
});

it('keeps an in-flight star intact and blocks a second write until it resolves', async () => {
  let finish!: () => void;
  let starred = false;
  const second = { ...file, id: 'file-2', filename: 'Brief.pdf' };
  respond((url, init) => {
    if (init.method === 'POST') return new Promise(resolve => {
      finish = () => { starred = true; resolve({ starred }); };
    });
    return { items: [{ ...file, starred }, second], next_cursor: null };
  });
  render(<CollectionRailPreview {...props} view="files"/>);
  await userEvent.click(await screen.findByRole('button', { name: 'More actions for Plan.pdf' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Star file' }));
  const filter = screen.getByRole('button', { name: 'Starred' }) as HTMLButtonElement;
  expect(filter.disabled).toBe(true);
  await userEvent.click(filter);
  await userEvent.click(screen.getByRole('button', { name: 'More actions for Brief.pdf' }));
  expect(screen.queryByRole('menu', { name: 'More actions for Brief.pdf' })).toBeNull();
  expect(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.signal?.aborted).toBe(false);
  await act(async () => finish());
  expect(filter.disabled).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'More actions for Plan.pdf' }));
  expect(screen.getByRole('menuitem', { name: 'Unstar file' })).toBeTruthy();
});

it('opens a standalone to-do by its ID and opens the destination header without a selection', async () => {
  respond(() => ({ items: [{ ...todo, channel_id: null, message_id: null }], next_cursor: null }));
  render(<CollectionRailPreview {...props} view="todos"/>);
  await userEvent.click(await screen.findByRole('button', { name: todo.title }));
  expect(props.onOpenDestination).toHaveBeenLastCalledWith(todo.id);
  await userEvent.click(screen.getByRole('button', { name: 'To-dos' }));
  expect(props.onOpenDestination).toHaveBeenLastCalledWith();
});
