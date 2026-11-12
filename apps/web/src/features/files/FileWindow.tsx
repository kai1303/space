import { useEffect, useState } from 'react';
import type { AssetAttachment } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { AssetViewer } from './AssetAttachments.js';

export default function FileWindow({ id }: { id: string }) {
  const [asset, setAsset] = useState<AssetAttachment>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request<AssetAttachment>(`/assets/${id}/details`, undefined, undefined, undefined, controller.signal)
      .then(file => { if (!controller.signal.aborted) setAsset(file); })
      .catch(() => { if (!controller.signal.aborted) setError('This file is unavailable.'); });
    return () => controller.abort();
  }, [id]);
  return asset && !error ? <AssetViewer standalone assets={[asset]} selectedId={id} onSelect={() => {}} onClose={() => {
    window.close();
    if (!window.closed) window.location.replace('/chat');
  }} onAccessLost={() => setError('This file is unavailable.')} /> : <p role="status">{error || 'Opening file…'}</p>;
}
