import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelPermissionSnapshot } from '@space/contracts';
import { ChannelPermissionEditor } from './ChannelPermissions.js';
const mocks = vi.hoisted(() => ({ request: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../shared/api/request.js', () => ({ request: mocks.request }));
vi.mock('../../shared/realtime/live-updates.js', () => ({ invalidateUpdates: mocks.invalidate }));
const snapshot: ChannelPermissionSnapshot = { revision: '7', posting: 'everyone', poster_ids: [], manager_ids: ['owner'], allow_replies: true, allow_broadcast: true, invite: 'managers', remove: 'managers', edit_details: 'managers', archive: 'managers', capabilities: { post: true, reply: true, broadcast: true, invite: true, remove: true, edit_details: true, archive: true, manage: true } };
const members = [{ id: 'owner', name: 'Owner', title: '', image: null, presence: 'active' as const, guest_type: 'none' as const }, { id: 'guest', name: 'Guest', title: '', image: null, presence: 'away' as const, guest_type: 'single' as const }];
const props = { channel: 'channel', snapshot, members, onClose: vi.fn(), onSaved: vi.fn() };
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); }; });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('reveals thread permission for restricted posting and saves revision plus only posting fields', async () => {
  mocks.request.mockResolvedValue(snapshot); render(<ChannelPermissionEditor {...props} section="posting" />);
  expect(screen.queryByRole('checkbox', { name: 'Allow threads' })).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: 'Admins plus specific people' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Guest' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Allow threads' }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Allow @everyone, @here and @channel' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(mocks.request).toHaveBeenCalledWith('/channels/channel/permissions', { revision: '7', posting: 'selected', poster_ids: ['guest'], allow_replies: false, allow_broadcast: false }, undefined, 'PATCH');
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  expect(mocks.invalidate).toHaveBeenCalledWith('channel', 'channel');
});
it('reloads a conflicting revision without silently resubmitting changes', async () => {
  mocks.request.mockRejectedValueOnce(new Error('channel_permissions_conflict')).mockResolvedValueOnce({ ...snapshot, revision: '8', posting: 'admins' });
  render(<ChannelPermissionEditor {...props} section="posting" />);
  await userEvent.click(screen.getByRole('radio', { name: 'Everyone except guests' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('changed'));
  expect(mocks.request.mock.calls.filter(call => call[3] === 'PATCH')).toHaveLength(1);
  expect(screen.getByRole('radio', { name: 'Admins only' })).toHaveProperty('checked', true);
  expect(props.onSaved).not.toHaveBeenCalled();
});
it('offers only nonguest channel members as delegated managers', async () => {
  mocks.request.mockResolvedValue(snapshot); render(<ChannelPermissionEditor {...props} section="managers" />);
  expect(screen.queryByRole('checkbox', { name: 'Guest' })).toBeNull();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Owner' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(mocks.request).toHaveBeenCalledWith('/channels/channel/permissions', { revision: '7', manager_ids: [] }, undefined, 'PATCH');
});
it('retains choices and exposes failures when saving member-action policies', async () => {
  mocks.request.mockRejectedValueOnce(new Error('forbidden')); render(<ChannelPermissionEditor {...props} section="actions" />);
  await userEvent.click(screen.getByRole('combobox', { name: 'Invite people' }));
  await userEvent.click(screen.getByRole('option', { name: 'Full members' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'forbidden');
  expect(screen.getByRole('combobox', { name: 'Invite people' }).textContent).toBe('Full members');
  expect(mocks.request).toHaveBeenCalledWith('/channels/channel/permissions', { revision: '7', invite: 'members', remove: 'managers', edit_details: 'managers', archive: 'managers' }, undefined, 'PATCH');
});
it('prevents stale retry when conflict reload fails', async () => {
  mocks.request.mockRejectedValueOnce(new Error('channel_permissions_conflict')).mockRejectedValueOnce(new Error('offline'));
  render(<ChannelPermissionEditor {...props} section="posting" />);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
});

it('keeps manager search usable and saves later selections against the returned revision', async () => {
  let finish!: (result: ChannelPermissionSnapshot) => void;
  mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(snapshot);
  render(<ChannelPermissionEditor {...props} section="managers" />);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Owner' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await userEvent.type(screen.getByRole('searchbox'), 'Own');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Owner' }));
  expect(screen.getByRole('button', { name: 'Saving managers…' })).toHaveProperty('disabled', true);
  await act(async () => finish({ ...snapshot, revision: '8', manager_ids: [] }));
  expect(screen.getByRole('checkbox', { name: 'Owner' })).toHaveProperty('checked', true);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(mocks.request).toHaveBeenLastCalledWith('/channels/channel/permissions', { revision: '8', manager_ids: ['owner'] }, undefined, 'PATCH');
});

it('keeps changes made during a conflict reload and waits for an explicit save', async () => {
  let finish!: (value: ChannelPermissionSnapshot) => void;
  mocks.request.mockRejectedValueOnce(new Error('channel_permissions_conflict')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(snapshot);
  render(<ChannelPermissionEditor {...props} section="posting" />);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('button', { name: 'Refreshing permissions…' })).toHaveProperty('disabled', true);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Allow @everyone, @here and @channel' }));
  await act(async () => finish({ ...snapshot, revision: '9', posting: 'admins' }));
  expect(screen.getByRole('radio', { name: 'Admins only' })).toHaveProperty('checked', true);
  expect(mocks.request).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(mocks.request).toHaveBeenLastCalledWith('/channels/channel/permissions', expect.objectContaining({ revision: '9', allow_broadcast: false, posting: 'admins' }), undefined, 'PATCH');
});

it('can dismiss a pending member-permission save and still publish the acknowledged change', async () => {
  let finish!: (value: ChannelPermissionSnapshot) => void;
  mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ChannelPermissionEditor {...props} section="actions" />);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Remove people' }));
  await userEvent.click(screen.getByRole('option', { name: 'Full members' }));
  await userEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
  await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => finish(snapshot));
  expect(props.onSaved).toHaveBeenCalledWith(snapshot);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
