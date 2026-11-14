import { useEffect, useState } from 'react';
import type { AssetAttachment } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { Button, LoadingStatus } from '@space/ui/primitives';
import { AssetViewer } from './AssetAttachments.js';

type FileProps = { id: string; initialPage?: number };
export default function FileWindow(props: FileProps) {
  return <FileContent key={props.id} {...props}/>;
}
function FileContent({ id, initialPage }: FileProps) {
  const [asset, setAsset] = useState<AssetAttachment>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request<AssetAttachment>(`/assets/${id}/details`, undefined, undefined, undefined, controller.signal)
      .then(file => { if (!controller.signal.aborted) setAsset(file); })
      .catch(() => { if (!controller.signal.aborted) setError('This file is unavailable.'); });
    return () => controller.abort();
  }, [id]);
  function close() {
    window.close();
    if (!window.closed) window.location.replace('/chat');
  }
  if (error || !asset) return <main className="file-window-status">
    {error ? <p role="alert">{error}</p> : <LoadingStatus>Opening file…</LoadingStatus>}
    <Button onClick={close}>Close file</Button>
  </main>;
  return <AssetViewer standalone initialPage={initialPage} assets={[asset]} selectedId={id} onSelect={() => {}}
    onClose={close} onAccessLost={() => setError('This file is unavailable.')} />;
}
