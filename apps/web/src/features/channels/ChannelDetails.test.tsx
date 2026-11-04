import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelDetails } from './ChannelDetails.js';
import type { ChannelDetails as Details } from '@space/contracts';

const channel: Details = { id: 'channel', workspace_id: 'workspace', name: 'product', private: false, joined: true, topic: 'Milestone', description: '', archived_at: null, created_by: 'owner', created_at: '2026-11-03T00:00:00Z', creator_name: 'Owner', can_manage: true, member_count: 1 };
const members = [{ id: 'owner', name: 'Owner', title: '', image: null, presence: 'active' }];
const props = { channel, viewer: 'owner', open: true, onClose: vi.fn(), onChange: vi.fn(), onLeft: vi.fn() };
function setup(details = channel) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, status: 200, json: async () => url.endsWith('/members?limit=100') ? { items: members, next_cursor: null } : url.includes('/participants') ? { items: [{ id: 'other', kind: 'human', name: 'Teammate' }], next_cursor: null } : init?.method === 'PATCH' ? { ...details, ...JSON.parse(init.body as string) } : details })));
}
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('edits one field without replacing other metadata and restores focus after cancellation', async () => {
  setup(); render(<ChannelDetails {...props} />);
  const edit = await screen.findByRole('button', { name: 'Edit channel topic' });
  await userEvent.click(edit);
  const dialog = screen.getByRole('dialog', { name: 'Edit topic' });
  const input = within(dialog).getByRole('textbox', { name: 'Topic' });
  expect(document.activeElement).toBe(input);
  await userEvent.clear(input); await userEvent.type(input, 'New milestone');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ topic: 'New milestone', description: '' })));
  expect(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body).toBe('{"topic":"New milestone"}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit topic' })).toBeNull());
  await userEvent.click(edit);
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Edit topic' })).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit topic' })).toBeNull());
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
});

it('members can inspect details and leave without seeing manager actions', async () => {
  setup({ ...channel, can_manage: false }); render(<ChannelDetails {...props} viewer="other" />);
  await screen.findByText('Milestone');
  expect(screen.queryByRole('button', { name: 'Edit channel topic' })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Members 1' }));
  expect(screen.queryByRole('button', { name: 'Add people' })).toBeNull();
  expect(screen.getByText('Owner', { exact: true })).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
  expect(screen.queryByRole('button', { name: 'Archive channel for everyone' })).toBeNull();
});

it('archiving requires confirmation and keeps server failures visible', async () => {
  setup(); render(<ChannelDetails {...props} initialTab="settings" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Archive channel for everyone' }));
  const dialog = screen.getByRole('dialog', { name: 'Archive #product?' });
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: false, status: 409, json: async () => ({ error: 'channel_has_active_tasks' }) }) as Response);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Archive channel', exact: true }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Resolve pending or running agent tasks before archiving this channel.');
  expect(props.onChange).not.toHaveBeenCalled();
});

it('adding a workspace person posts their ID and refreshes membership', async () => {
  setup(); render(<ChannelDetails {...props} initialTab="members" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Add people' }));
  const dialog = screen.getByRole('dialog', { name: 'Add people to #product' });
  await userEvent.click(await within(dialog).findByRole('radio', { name: 'Teammate' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add', exact: true }));
  await waitFor(() => expect(props.onChange).toHaveBeenCalled());
  const call = vi.mocked(fetch).mock.calls.find(([url, init]) => url === '/v1/channels/channel/members' && init?.method === 'POST');
  expect(call?.[1]?.body).toBe('{"user_id":"other"}');
});
