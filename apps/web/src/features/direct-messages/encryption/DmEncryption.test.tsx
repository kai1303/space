import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { DirectMessageSummary } from '@space/contracts';
import { request } from '../../../shared/api/request.js';
import { deviceState, type DeviceState } from './device-storage.js';
import { useDmEncryption } from './DmEncryption.js';
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
