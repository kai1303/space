import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DirectMessageSummary } from '@space/contracts';
import { request } from '../../../shared/api/request.js';
import { deviceState, type DeviceState } from './device-storage.js';
import { EncryptedSearch, EncryptionSettings, useDmEncryption } from './DmEncryption.js';
import { DM_DRAFT_KEY_AVAILABLE } from './draft-crypto.js';

vi.mock('../../../shared/api/request.js', () => ({ request: vi.fn() }));
vi.mock('../../../shared/realtime/live-updates.js', () => ({
  subscribeUpdates: (_scope: string, _id: string, refresh: () => Promise<void>) => {
    void refresh();
    return () => {};
  },
}));
vi.mock('./device-storage.js', () => ({ deviceState: vi.fn() }));
vi.mock('./crypto.js', () => ({ authorizeDevice: () => Promise.resolve('proof') }));

afterEach(cleanup);

it('unlocks an existing draft on confirmed enrollment and clears the local marker on revocation', async () => {
  const viewer = 'alice', channel = 'room';
  let stored = { identity: { id: 'device', publicKey: 'public' }, recovery: 'a'.repeat(64) } as DeviceState;
  vi.mocked(deviceState).mockImplementation(async (_viewer, _channel, update) => {
    if (update) stored = update(stored);
    return stored;
  });
  const device = { id: 'device', user_id: viewer, public_key: 'public', authorization: 'wrong', revoked: false };
  vi.mocked(request).mockImplementation(async () => ({ enabled: true, devices: [device] }));
  const onKey = vi.fn();
  window.addEventListener(DM_DRAFT_KEY_AVAILABLE, onKey);
  try {
    const dm = { id: channel, participants: [] } as unknown as DirectMessageSummary;
    const { result, unmount } = renderHook(() => useDmEncryption(dm, viewer));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(stored.linked).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    device.authorization = 'proof';
    await act(() => result.current.refresh());
    expect(stored.linked).toBe(true);
    expect(onKey.mock.calls[0]?.[0].detail).toEqual({ viewer, channel });
    device.revoked = true;
    await act(() => result.current.refresh());
    expect(stored.linked).toBe(false);
    expect(onKey).toHaveBeenCalledTimes(1);
    unmount();
  } finally {
    window.removeEventListener(DM_DRAFT_KEY_AVAILABLE, onKey);
  }
});

it('shows a recoverable device-check error and keeps registration gated until the retry succeeds', async () => {
  vi.mocked(deviceState).mockResolvedValue(undefined);
  let finish!: (value: unknown) => void;
  vi.mocked(request).mockRejectedValueOnce(new Error('Device list unavailable')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const dm = { id: 'dm', participants: [], encrypted_since: '2026-11-12' } as unknown as DirectMessageSummary;
  function Settings() {
    return <EncryptionSettings dm={dm} actor="alice" control={useDmEncryption(dm, 'alice')} />;
  }
  render(<Settings />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Checking device status…')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Register this device' })).toBeNull();
  const refresh = screen.getByRole('button', { name: 'Refresh' });
  fireEvent.click(refresh);
  expect(refresh.getAttribute('aria-busy')).toBe('true');
  await act(async () => finish({ enabled: true, devices: [] }));
  expect(screen.getByRole('button', { name: 'Register this device' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps matches clickable during older-message search and ignores a cancelled page', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  vi.mocked(deviceState).mockResolvedValue(undefined);
  let finish!: (value: unknown) => void;
  vi.mocked(request).mockImplementation(async path => path.endsWith('/encryption') ? { enabled: true, devices: [] }
    : path.includes('before=') ? new Promise(resolve => { finish = resolve; })
    : { messages: [{ id: 'one', text: 'Launch plan' }], has_older: true, older_cursor: 'earlier' });
  const dm = { id: 'dm', participants: [] } as unknown as DirectMessageSummary;
  const open = vi.fn();
  function Search() {
    return <EncryptedSearch channel={dm.id} actor="alice" control={useDmEncryption(dm, 'alice')} onClose={() => {}} onOpen={open} />;
  }
  render(<Search />);
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'launch' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  const match = await screen.findByRole('button', { name: 'Launch plan' });
  const older = screen.getByRole('button', { name: 'Search older messages' });
  fireEvent.click(older);
  expect(older.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(match);
  expect(open).toHaveBeenCalledWith('one');
  fireEvent.change(input, { target: { value: 'new' } });
  await act(async () => finish({ messages: [{ id: 'two', text: 'Launch date' }], has_older: false }));
  expect(screen.queryByText('Launch date')).toBeNull();
  expect(screen.queryByText('No matches in the messages searched.')).toBeNull();
});
