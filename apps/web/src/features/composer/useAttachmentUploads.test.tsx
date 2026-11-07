import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { AssetAttachment } from '@space/contracts';
import { useAttachmentUploads } from './useAttachmentUploads.js';
import { uploadAsset } from '../files/assets.js';
vi.mock('../files/assets.js', () => ({ uploadAsset: vi.fn() }));
vi.mock('../../shared/api/request.js', () => ({ request: vi.fn(async () => ({ enabled: true })) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('preserves the file, latest description and reorder when an upload finishes', async () => {
  let resolve!: (asset: AssetAttachment) => void;
  vi.mocked(uploadAsset).mockReturnValue(new Promise(done => { resolve = done; }));
  const file = new File(['x'], 'photo.png', { type: 'image/png' });
  const { result } = renderHook(() => useAttachmentUploads('viewer'));
  await waitFor(() => expect(result.current.uploads.enabled).toBe(true));
  act(() => result.current.uploads.change('channel', 'channel', [{ id: 'temp', name: file.name, size: 1, type: file.type, file, status: 'uploading' }]));
  act(() => result.current.uploads.change('channel', 'channel', [
    { id: 'other', name: 'notes.txt', size: 1, type: 'text/plain', status: 'ready' },
    { ...result.current.uploads.drafts.channel![0]!, description: 'Edited during upload' },
  ]));
  await act(async () => resolve({ id: 'server', name: file.name, size: 1, type: file.type }));
  expect(result.current.uploads.drafts.channel?.map(item => item.id)).toEqual(['other', 'server']);
  expect(result.current.uploads.drafts.channel?.[1]).toMatchObject({ file, description: 'Edited during upload', status: 'ready' });
  expect(uploadAsset).toHaveBeenCalledTimes(1);
});
