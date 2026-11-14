import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { AssetAttachment } from '@space/contracts';
import { useAttachmentUploads } from './useAttachmentUploads.js';
import { uploadAsset } from '../files/assets.js';
import { pendingToast, toast } from '@space/ui/primitives';
vi.mock('@space/ui/primitives', () => ({ pendingToast: vi.fn(), toast: { update: vi.fn(), dismiss: vi.fn() } }));
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

it('tracks concurrent uploads independently and dismisses a cancelled upload without showing a late success', async () => {
  const jobs: { progress: (percent: number) => void; finish: (asset: AssetAttachment) => void }[] = [];
  vi.mocked(uploadAsset).mockImplementation((_channel, _file, progress) => new Promise(finish => jobs.push({ progress, finish })));
  vi.mocked(pendingToast).mockReturnValueOnce('first').mockReturnValueOnce('second');
  const { result } = renderHook(() => useAttachmentUploads('viewer'));
  await waitFor(() => expect(result.current.uploads.enabled).toBe(true));
  const files = ['a.txt', 'b.txt'].map(id => ({
    id, name: id, size: 1, type: 'text/plain', status: 'uploading' as const, file: new File(['x'], id),
  }));
  act(() => result.current.uploads.change('channel', 'channel', files));
  act(() => jobs[0]!.progress(45));
  expect(toast.update).toHaveBeenCalledWith('first', { progress: 0.45, meta: '45%' });
  act(() => result.current.uploads.change('channel', 'channel', [files[1]!]));
  expect(toast.dismiss).toHaveBeenCalledWith('first');
  await act(async () => jobs.forEach((job, index) => job.finish(files[index]!)));
  expect(toast.update).toHaveBeenCalledWith('second', expect.objectContaining({ type: 'success' }));
  expect(toast.update).not.toHaveBeenCalledWith('first', expect.objectContaining({ type: 'success' }));
});

it('keeps private DM drafts in memory and removes them when access is lost', async () => {
  const { result } = renderHook(() => useAttachmentUploads('viewer'));
  await waitFor(() => expect(result.current.uploads.enabled).toBe(true));
  const secret = { ops: [{ insert: 'private DM draft' }] };
  act(() => {
    result.current.saveDraft('encrypted:dm', secret);
    result.current.saveDraft('channel', { ops: [{ insert: 'channel draft' }] });
  });
  expect(result.current.draftState.current['encrypted:dm']).toEqual(secret);
  expect(localStorage.getItem('space:composer-drafts:viewer')).not.toContain('private DM draft');
  act(() => result.current.forgetChannelDrafts('dm'));
  expect(result.current.draftState.current['encrypted:dm']).toBeUndefined();
});
