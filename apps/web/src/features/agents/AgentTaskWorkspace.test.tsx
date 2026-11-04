import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@space/contracts';
import { AgentTaskCard, AgentTaskWorkspace, AgentWorkspaceView, type TaskOutputs } from './AgentTaskWorkspace.js';

const live = vi.hoisted(() => new Map<string, (code: string) => void>());
vi.mock('../../shared/realtime/live-updates.js', () => ({ subscribeUpdates: (_scope: string, id: string, read: () => unknown, revoke?: (code: string) => void) => {
  if (revoke) live.set(id, revoke);
  void read();
  const focus = () => { void read(); };
  window.addEventListener('focus', focus);
  return () => { live.delete(id); window.removeEventListener('focus', focus); };
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const task: Task = {
  id: 'task-a', workspace_id: 'workspace', thread_id: 'thread', installation_id: 'agent',
  goal: 'Build a delivery dashboard', skill: 'demo.echo', requester_id: 'user', approved_by: 'user',
  status: 'completed', session_id: 'session', active_execution_id: 'execution', revision: 4,
  result: 'Added a dashboard and verified the filters.',
};
const outputs: TaskOutputs = {
  preview: { state: 'ready', url: 'https://preview.example.test', label: 'Delivery dashboard' },
  files: [{ path: 'src/dashboard.tsx', content: 'export const title = "Delivery";', language: 'typescript' }, { path: 'report.txt', content: 'Filters passed.' }],
  changes: [{ path: 'src/dashboard.tsx', patch: '@@ -1 +1 @@\n-const title = "Old";\n+const title = "Delivery";' }],
};

it('opens a task from a readable card with its current status', async () => {
  const open = vi.fn();
  render(<AgentTaskCard title={task.goal} status="running" detail="Testing the filters" onOpen={open} />);
  expect(screen.getByText('Running')).toBeTruthy();
  expect(screen.getByText('Testing the filters')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Open agent session' }));
  expect(open).toHaveBeenCalledTimes(1);
});

it('opens directly into three output tabs without Logs or a duplicate task summary', () => {
  render(<AgentWorkspaceView task={task} outputs={outputs} onClose={() => {}} />);
  expect(screen.queryByRole('list', { name: 'Task progress' })).toBeNull();
  expect(screen.queryByText(task.goal)).toBeNull();
  expect(screen.queryByText('View result')).toBeNull();
  expect(screen.queryByText(task.result!)).toBeNull();
  expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('tab', { name: 'Logs' })).toBeNull();
  expect(screen.getAllByRole('tab')).toHaveLength(3);
});

it('opens Preview when no app or output is attached', () => {
  render(<AgentWorkspaceView task={task} onClose={() => {}} />);
  expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText('No preview attached')).toBeTruthy();
});

it('switches result tabs with the keyboard and shows saved files and changes', async () => {
  render(<AgentWorkspaceView task={task} outputs={outputs} onClose={() => {}} />);
  const preview = screen.getByTitle('Delivery dashboard');
  expect(preview.getAttribute('src')).toBe(new URL(outputs.preview!.url!).href);
  expect(preview.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(preview.getAttribute('referrerpolicy')).toBe('no-referrer');
  screen.getByRole('tab', { name: 'Preview' }).focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'Files 2' }).getAttribute('aria-selected')).toBe('true');
  await userEvent.click(screen.getByRole('button', { name: 'report.txt' }));
  expect(screen.getByText('Filters passed.')).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: 'Changes 1' }));
  expect(screen.getByText('+const title = "Delivery";')).toBeTruthy();

});

it('downloads the original file content', async () => {
  const create = vi.fn(() => 'blob:download');
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = vi.fn(); });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<AgentWorkspaceView task={task} outputs={outputs} onClose={() => {}} />);
  await userEvent.click(screen.getByRole('tab', { name: 'Files 2' }));
  await userEvent.click(screen.getByRole('button', { name: 'Download dashboard.tsx' }));
  expect(create).toHaveBeenCalledWith(expect.any(Blob));
  expect(click.mock.instances[0]).toHaveProperty('download', 'dashboard.tsx');
});

it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://user:secret@example.test'])('does not embed an unsafe preview URL: %s', url => {
  const view = render(<AgentWorkspaceView task={task} outputs={{ ...outputs, preview: { state: 'ready', url, label: 'Unsafe preview' } }} onClose={() => {}} />);
  expect(view.container.querySelector('iframe')).toBeNull();
  expect(screen.getByText('Preview unavailable')).toBeTruthy();
});

it('keeps saved results available when the preview is stopped and does not pretend resume is wired', async () => {
  const view = render(<AgentWorkspaceView task={task} outputs={{ ...outputs, preview: { ...outputs.preview!, state: 'stopped' } }} onClose={() => {}} />);
  expect(screen.getByText('Preview is offline')).toBeTruthy();
  expect(view.container.querySelector('iframe')).toBeNull();
  expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Files 2' }));
  expect(screen.getByRole('button', { name: 'report.txt' })).toBeTruthy();
});

it('shows honest empty output states for a task without a connected sandbox', async () => {
  render(<AgentWorkspaceView task={task} onClose={() => {}} />);
  await userEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  expect(screen.getByText('No preview attached')).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: 'Files 0' }));
  expect(screen.getByText('No files attached')).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: 'Changes 0' }));
  expect(screen.getByText('No code changes attached')).toBeTruthy();
});

it('loads the task without requesting hidden activity or approval data', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => task })));
  render(<AgentTaskWorkspace taskId={task.id} ownerId="user" viewerId="user" onClose={() => {}} />);
  await screen.findByText('No preview attached');
  expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(['/v1/tasks/task-a']);
});

it('clears private output after access is revoked', async () => {
  let denied = false;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => denied
    ? { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
    : { ok: true, json: async () => path.includes('/events') ? [] : ({ ...task, status: 'running' }) }));
  const revoked = vi.fn();
  render(<AgentTaskWorkspace taskId={task.id} ownerId="user" viewerId="user" onClose={() => {}} onAccessLost={revoked} />);
  await screen.findByText('No preview attached');
  denied = true;
  fireEvent.focus(window);
  await waitFor(() => expect(screen.queryByRole('tab', { name: 'Preview' })).toBeNull());
  expect(revoked).toHaveBeenCalledTimes(1);
});

it('ignores a late task response after switching to another task', async () => {
  let finish!: (response: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/v1/tasks/task-a') return new Promise(resolve => { finish = resolve; });
    return { ok: true, json: async () => path.includes('/events') ? [] : { ...task, id: 'task-b', result: 'The next task result' } };
  }));
  const view = render(<AgentTaskWorkspace taskId="task-a" ownerId="user" viewerId="user" onClose={() => {}} />);
  view.rerender(<AgentTaskWorkspace taskId="task-b" ownerId="user" viewerId="user" onClose={() => {}} />);
  await screen.findByText('task-b');
  await act(async () => { finish({ ok: true, json: async () => task }); });
  expect(screen.queryByText('task-a')).toBeNull();
});

it('closes with Escape and exposes a retry after a failed initial read', async () => {
  let failed = true;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (failed) throw new TypeError('Network error');
    return { ok: true, json: async () => path.includes('/events') ? [] : task };
  }));
  const close = vi.fn();
  render(<AgentTaskWorkspace taskId={task.id} ownerId="user" viewerId="other" onClose={close} />);
  await screen.findByRole('alert');
  failed = false;
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('No preview attached');
  expect(screen.queryByRole('button', { name: 'Approve task' })).toBeNull();
  await userEvent.keyboard('{Escape}');
  expect(close).toHaveBeenCalledTimes(1);
});

it('focuses the close button and supports Escape while the initial request is pending', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const close = vi.fn();
  render(<AgentTaskWorkspace taskId={task.id} ownerId="user" viewerId="user" onClose={close} />);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close agent workspace' }));
  await userEvent.keyboard('{Escape}');
  expect(close).toHaveBeenCalledTimes(1);
});

it('keeps file search focused when the parent updates its close callback', async () => {
  const view = render(<AgentWorkspaceView task={task} outputs={outputs} onClose={() => {}} />);
  await userEvent.click(screen.getByRole('tab', { name: 'Files 2' }));
  const search = screen.getByRole('searchbox', { name: 'Search task files' });
  await userEvent.type(search, 'report');
  view.rerender(<AgentWorkspaceView task={task} outputs={outputs} onClose={() => {}} />);
  expect(document.activeElement).toBe(search);
});

it('clears the task immediately on socket revocation even when HTTP is unavailable', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => task })));
 const revoked = vi.fn();
 render(<AgentTaskWorkspace taskId={task.id} ownerId="user" viewerId="user" onClose={() => {}} onAccessLost={revoked} />);
 await screen.findByText('No preview attached');
 vi.mocked(fetch).mockRejectedValue(new TypeError('Offline'));
 act(() => { live.get(task.id)?.('not_found'); });
 expect(screen.queryByRole('tab', { name: 'Preview' })).toBeNull();
 expect(revoked).toHaveBeenCalledTimes(1);
});
