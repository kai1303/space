import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SpacebotPreview } from './SpacebotPreview.js';

const mock = vi.hoisted(() => ({ request: vi.fn(), stop: vi.fn(), read: () => {}, revoke: (_reason: string) => {} }));
vi.mock('../../../shared/api/request.js', () => ({ request: mock.request }));
vi.mock('../../../shared/realtime/live-updates.js', () => ({
  subscribeUpdates: (_scope: string, _id: string, read: () => unknown, revoke: (reason: string) => void) => {
    mock.revoke = revoke;
    mock.read = read;
    void read();
    return mock.stop;
  },
  invalidateUpdates: () => mock.read(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const session = { id: 'session', channel_id: 'channel', title: 'Review the weekly plan', agent_name: 'Kai’s agent', created_at: '2026-11-09T03:00:00Z' };
const callbacks = { onNewMessage: vi.fn(), onOpenSession: vi.fn(), onOpenTodos: vi.fn() };

it('shows the workspace’s recent agent sessions and starts new conversations from an explicit action', async () => {
  mock.request.mockResolvedValue({ items: [session], next_cursor: null });
  render(<SpacebotPreview workspace="workspace" {...callbacks} />);
  fireEvent.click(await screen.findByRole('button', { name: /Review the weekly plan/ }));
  expect(callbacks.onOpenSession).toHaveBeenCalledWith(session);
  expect(callbacks.onNewMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'New message' }));
  expect(callbacks.onNewMessage).toHaveBeenCalledOnce();
  expect(mock.request.mock.calls.map(([path]) => path)).toEqual(['/workspaces/workspace/agent-sessions']);
  const signal = mock.request.mock.calls[0]![4] as AbortSignal;
  act(() => mock.revoke('forbidden'));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText(session.title)).toBeNull();
  expect(screen.getByRole('alert')).toBeTruthy();
});

it('opens Agenda on demand with upcoming reminders and resets across workspaces', async () => {
  mock.request.mockImplementation(async (path: string) => ({
    items: path.includes('/todos?') ? [{ id: 'todo', title: 'Ship the build', remind_at: '2028-01-01T13:00:00Z' }] : [],
    next_cursor: null,
  }));
  const view = render(<SpacebotPreview workspace="one" {...callbacks} />);
  await screen.findByText('No recent agent sessions.');
  fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
  expect(await screen.findByText('Ship the build')).toBeTruthy();
  expect(mock.request.mock.calls.some(([path]) => path.includes('/workspaces/one/hub/todos?status=open&reminder=upcoming&sort=due'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open To-dos' }));
  expect(callbacks.onOpenTodos).toHaveBeenCalledOnce();
  view.rerender(<SpacebotPreview workspace="two" {...callbacks} />);
  expect(screen.queryByText('Ship the build')).toBeNull();
  expect(await screen.findByText('No recent agent sessions.')).toBeTruthy();
  expect(mock.stop).toHaveBeenCalled();
});

it('retries a transient failure while the recent sessions panel is open', async () => {
  mock.request.mockRejectedValueOnce(new Error('Temporarily unavailable'));
  mock.request.mockResolvedValueOnce({ items: [session], next_cursor: null });
  render(<SpacebotPreview workspace="workspace" {...callbacks}/>);
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(session.title)).toBeTruthy();
});
