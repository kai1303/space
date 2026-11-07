import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
