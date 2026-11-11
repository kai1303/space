import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScheduledMessage } from '@space/contracts';
import { ScheduledMessages } from './ScheduledMessages.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const item = (patch: Partial<ScheduledMessage> = {}): ScheduledMessage => ({ id: 'one', workspace_id: 'w', channel_id: 'c', channel_name: 'launch', thread_id: null,
  text: 'Release notes at nine', document: null, attachments: [], send_at: new Date(Date.now() + 86_400_000).toISOString(), status: 'pending',
  message_id: null, error: null, created_at: new Date().toISOString(), ...patch });
const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, headers: new Headers() });

function server(list: ScheduledMessage[]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === 'GET') return reply({ items: list });
    if (method === 'DELETE') return reply({ ...list[0], status: 'cancelled' });
    if (url.endsWith('/send')) return reply({ ...list[0], status: 'sending' });
    return reply({ ...list[0], send_at: body.send_at });
  }));
  return calls;
}

it('lists scheduled messages with their channel and time, and cancels one', async () => {
  const calls = server([item()]);
  render(<ScheduledMessages workspace="w" onOpen={() => {}} />);
  expect(await screen.findByText('#launch')).toBeTruthy();
  expect(screen.getByText('Release notes at nine')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByText('#launch')).toBeNull());
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/v1/scheduled-messages/one' });
  expect(screen.getByText('No scheduled messages')).toBeTruthy();
});

it('sends now and edits the time with validation', async () => {
  const calls = server([item()]);
  render(<ScheduledMessages workspace="w" onOpen={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Send now' }));
  await waitFor(() => expect(screen.getByText('Sending…')).toBeTruthy());
  expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/v1/scheduled-messages/one/send' });
  expect(screen.queryByRole('button', { name: 'Edit time' })).toBeNull();
});

it('rejects a past time when editing and saves a valid one', async () => {
  const calls = server([item()]);
  render(<ScheduledMessages workspace="w" onOpen={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit time' }));
  const field = screen.getByLabelText('New time');
  fireEvent.change(field, { target: { value: '2000-01-01T09:00' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save time' }));
  expect(screen.getByRole('alert').textContent).toMatch(/minute/);
  const later = new Date(Date.now() + 2 * 86_400_000);
  fireEvent.change(field, { target: { value: new Date(later.getTime() - later.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) } });
  await userEvent.click(screen.getByRole('button', { name: 'Save time' }));
  await waitFor(() => expect(calls.at(-1)?.method).toBe('PATCH'));
  expect(Math.abs(Date.parse((calls.at(-1)!.body as { send_at: string }).send_at) - later.getTime())).toBeLessThan(60_000);
});

it('explains a failed schedule and opens its conversation', async () => {
  server([item({ status: 'failed', error: 'not_found' })]);
  const onOpen = vi.fn();
  render(<ScheduledMessages workspace="w" onOpen={onOpen} />);
  expect(await screen.findByText(/no longer have access/)).toBeTruthy();
  await userEvent.click(screen.getByText('#launch'));
  expect(onOpen).toHaveBeenCalledWith({ channel_id: 'c' });
});
