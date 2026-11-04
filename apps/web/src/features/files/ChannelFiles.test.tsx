import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelFile } from '@space/contracts';
import { ChannelFiles } from './ChannelFiles.js';

const file = (id: string, preview_kind: ChannelFile['preview_kind'] = 'image'): ChannelFile => ({ id, name: `${id}.png`, type: 'image/png', size: 1024, preview_kind, message_id: `message-${id}`, thread_id: 'thread', shared_at: '2026-11-03T01:00:00.000Z', uploader: { id: 'user', name: 'Kai' } });
const response = (items: ChannelFile[], next_cursor: string | null = null) => ({ ok: true, status: 200, json: async () => ({ items, next_cursor }) });
const props = { channel: 'one', name: 'general', onClose: vi.fn(), onMessage: vi.fn() };
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('focuses search and lists lightweight metadata, then previews with fresh authorization', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/preview') ? { ok: true, json: async () => ({ kind: 'unsupported', reason: 'unsupported_format' }) } : response([file('a'), file('b', 'file')])));
  render(<ChannelFiles {...props} />);
  expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search filenames' }));
  const panel = screen.getByRole('region', { name: 'Files in #general' });
  await within(panel).findByText('a.png');
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  expect(panel.querySelector('img')!.getAttribute('loading')).toBe('lazy');
  expect(screen.getByRole('link', { name: 'Download a.png' }).getAttribute('href')).toBe('/v1/assets/a/download');
  await userEvent.click(screen.getByRole('button', { name: 'View message for a.png' }));
  expect(props.onMessage).toHaveBeenCalledWith('message-a');
  const opener = screen.getByRole('button', { name: 'Preview b.png' });
  await userEvent.click(opener);
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('Preview unavailable')).toBeTruthy();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Close dialog' }), { key: 'ArrowLeft' });
  await screen.findByRole('dialog', { name: 'a.png' });
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(props.onClose).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it('paginates without duplicates and resets cursor for debounced search, kind, sort and refresh', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('after=') ? [file('a'), file('b')] : [file('a')], url.includes('after=') ? null : 'a')));
  render(<ChannelFiles {...props} />);
  await screen.findByText('a.png');
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/v1/channels/one/assets?q=&kind=all&sort=newest&limit=24');
  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('b.png');
  expect(screen.getAllByText('a.png')).toHaveLength(1);
  expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toContain('after=a');
  await userEvent.type(screen.getByRole('searchbox'), 'a_%');
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toContain('q=a_%25'));
  expect(vi.mocked(fetch).mock.calls.at(-1)![0]).not.toContain('after=');
  await userEvent.click(screen.getByLabelText('File type')); await userEvent.click(await screen.findByRole('option', { name: 'PDFs', exact: true }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toContain('kind=pdf'));
  await userEvent.click(screen.getByLabelText('Sort files')); await userEvent.click(await screen.findByRole('option', { name: 'Oldest shared', exact: true }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toContain('sort=oldest'));
  const count = vi.mocked(fetch).mock.calls.length;
  await userEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(count + 1));
});

it('aborts changed queries and channels and ignores responses that resolve after abort', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/one/') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(response([file('new')]))));
  const view = render(<ChannelFiles {...props} />);
  const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
  view.rerender(<ChannelFiles {...props} channel="two" name="private" />);
  expect(signal.aborted).toBe(true);
  await screen.findByText('new.png');
  await act(async () => { finish(response([file('stale')])); });
  expect(screen.queryByText('stale.png')).toBeNull();
  const lastSignal = vi.mocked(fetch).mock.calls.at(-1)![1]!.signal!;
  view.unmount();
  expect(lastSignal.aborted).toBe(true);
});

it.each([401, 403, 404])('clears private metadata after a %i refresh response', async status => {
  const expired = vi.fn();
  const lost = vi.fn();
  window.addEventListener('space:session-expired', expired);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response([file('secret')])).mockResolvedValue({ ok: false, status }));
  render(<ChannelFiles {...props} onAccessLost={lost} />);
  await screen.findByText('secret.png');
  await userEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
  await waitFor(() => expect(screen.queryAllByText('secret.png')).toHaveLength(0));
  await screen.findByRole('alert');
  expect(expired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  expect(lost).toHaveBeenCalledTimes(status === 401 ? 0 : 1);
  window.removeEventListener('space:session-expired', expired);
});

it('shows errors with retry, distinguishes filtered empty results and refreshes on revision', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response([])));
  const view = render(<ChannelFiles {...props} />);
  expect((await screen.findByRole('alert')).textContent).toContain('offline');
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('No files shared yet');
  await userEvent.click(screen.getByLabelText('File type')); await userEvent.click(await screen.findByRole('option', { name: 'Text', exact: true }));
  await screen.findByText('No files match your filters');
  const count = vi.mocked(fetch).mock.calls.length;
  view.rerender(<ChannelFiles {...props} revision="new-attachment" />);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(count + 1));
});

it.each([401, 403, 404])('clears panel and viewer when fresh preview authorization returns %i', async status => {
  const lost = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/preview') ? { ok: false, status } : response([file('secret')])));
  render(<ChannelFiles {...props} onAccessLost={lost} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Preview secret.png' }));
  await waitFor(() => expect(screen.queryAllByText('secret.png')).toHaveLength(0));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(status === 401 ? 'session has expired' : 'no longer have access');
  expect(lost).toHaveBeenCalledTimes(status === 401 ? 0 : 1);
});

it('clears loaded metadata and aborts requests when another request expires the session', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response([file('secret')])));
  render(<ChannelFiles {...props} />);
  await screen.findByText('secret.png');
  const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
  act(() => { window.dispatchEvent(new Event('space:session-expired')); });
  expect(screen.queryByText('secret.png')).toBeNull();
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('session has expired');
});

it('defers incoming-attachment refresh while reading a file and refreshes after closing the viewer', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/preview') ? { ok: true, json: async () => ({ kind: 'text', text: 'Keep reading', language: 'text', truncated: false }) } : response([file('reading', 'text')])));
  const view = render(<ChannelFiles {...props} revision="first" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Preview reading.png' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('Keep reading');
  view.rerender(<ChannelFiles {...props} revision="incoming" />);
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));
  expect(document.activeElement).toBe(screen.getByRole('searchbox'));
});
