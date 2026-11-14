import { afterEach, expect, it, vi } from 'vitest';
import { uploadAsset } from './assets.js';

class UploadRequest {
  static last: UploadRequest;
  upload = { onprogress: null as null | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) };
  status = 204;
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onabort: null | (() => void) = null;
  ontimeout: null | (() => void) = null;
  open = vi.fn();
  send = vi.fn<(body: FormData) => void>();
  abort = vi.fn(() => this.onabort?.());
  setRequestHeader = vi.fn();
  constructor() { UploadRequest.last = this; }
}
afterEach(() => vi.unstubAllGlobals());
const asset = { id: 'asset', name: 'report.txt', size: 4, type: 'text/plain' };
function prepare(put_url?: string) {
  UploadRequest.last = undefined!;
  vi.stubGlobal('XMLHttpRequest', UploadRequest);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/complete') ? asset : { asset, upload: { url: 'https://objects.test/upload', put_url, fields: { key: 'immutable/key', policy: 'signed-policy' } }, expires_at: 'future' } })));
}
it('uploads actual bytes in a signed multipart form with progress, then completes the asset', async () => {
  prepare();
  const file = new File(['data'], asset.name, { type: asset.type });
  const progress = vi.fn();
  const promise = uploadAsset('channel', file, progress, new AbortController().signal);
  await vi.waitFor(() => expect(UploadRequest.last?.send).toHaveBeenCalled());
  const xhr = UploadRequest.last;
  expect(xhr.open).toHaveBeenCalledWith('POST', 'https://objects.test/upload');
  expect(xhr.setRequestHeader).not.toHaveBeenCalled();
  const form = xhr.send.mock.calls[0]![0] as FormData;
  expect(form.get('key')).toBe('immutable/key');
  expect(form.get('policy')).toBe('signed-policy');
  expect(form.get('file')).toBe(file);
  expect([...form.keys()].at(-1)).toBe('file');
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 });
  expect(progress).toHaveBeenCalledWith(50);
  xhr.onload?.();
  await expect(promise).resolves.toEqual(asset);
  expect(vi.mocked(fetch).mock.calls.map(call => call[0])).toEqual(['/v1/channels/channel/assets', '/v1/assets/asset/complete']);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual({ name: file.name, size: file.size, type: file.type });
});
it('sends the file body directly when storage offers a signed PUT', async () => {
  const url = 'https://objects.test/direct';
  prepare(url);
  const file = new File(['data'], asset.name, {type: asset.type});
  const promise = uploadAsset('channel', file, () => {}, new AbortController().signal);
  await vi.waitFor(() => expect(UploadRequest.last?.send).toHaveBeenCalled());
  const xhr = UploadRequest.last;
  expect(xhr.open).toHaveBeenCalledWith('PUT', url);
  expect(xhr.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
  expect(xhr.send).toHaveBeenCalledWith(file);
  xhr.onload?.();
  await expect(promise).resolves.toEqual(asset);
});
it('does not complete an asset after object storage rejects it', async () => {
  prepare();
  const promise = uploadAsset('channel', new File(['data'], asset.name), () => {}, new AbortController().signal);
  const rejected = expect(promise).rejects.toThrow('Upload failed');
  await vi.waitFor(() => expect(UploadRequest.last.send).toHaveBeenCalled());
  UploadRequest.last.status = 403;
  UploadRequest.last.onload?.();
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('aborts removed files without completing or sending more bytes', async () => {
  prepare();
  const controller = new AbortController();
  const promise = uploadAsset('channel', new File(['data'], asset.name), () => {}, controller.signal);
  const rejected = expect(promise).rejects.toThrow('Upload cancelled');
  await vi.waitFor(() => expect(UploadRequest.last.send).toHaveBeenCalled());
  controller.abort();
  await rejected;
  expect(UploadRequest.last.abort).toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
