import type { AssetAttachment, AssetUpload } from '@space/contracts';
import { request } from '../../shared/api/request.js';

export type AssetConfig = { enabled: boolean; max_file_size: number; max_files: number };

export async function uploadAsset(channel: string, file: File, progress: (percent: number) => void, signal: AbortSignal, encrypted = false, expectedActor?: string): Promise<AssetAttachment> {
  if (signal.aborted) throw new Error('Upload cancelled');
  const signed = await request<AssetUpload>(`/channels/${channel}/assets`, { name: file.name, size: file.size, type: file.type || 'application/octet-stream', ...(encrypted ? {encrypted:true} : {}) }, undefined, 'POST', signal, expectedActor);
  if (signal.aborted) throw new Error('Upload cancelled');
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error?: Error) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const direct = signed.upload.put_url;
    xhr.open(direct ? 'PUT' : 'POST', direct ?? signed.upload.url);
    xhr.timeout = 5 * 60 * 1000;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && !signal.aborted) progress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? undefined : new Error('Upload failed. Try again.'));
    xhr.onerror = xhr.ontimeout = () => finish(new Error('Upload failed. Try again.'));
    xhr.onabort = () => finish(new Error('Upload cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (direct) {
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(file);
      return;
    }
    const form = new FormData();
    for (const [name, value] of Object.entries(signed.upload.fields)) form.append(name, value);
    form.append('file', file);
    xhr.send(form);
  });
  if (signal.aborted) throw new Error('Upload cancelled');
  const asset = await request<AssetAttachment>(`/assets/${signed.asset.id}/complete`, {}, undefined, 'POST', signal, expectedActor);
  if (signal.aborted) throw new Error('Upload cancelled');
  return asset;
}
