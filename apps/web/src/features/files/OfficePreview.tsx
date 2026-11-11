import { useEffect, useRef, useState } from 'react';
import { DocumentEditor, type DocumentEditorProps } from '@onlyoffice/document-editor-react';
import { sessionFetch } from '../../shared/api/session-fetch.js';

type Session = Pick<DocumentEditorProps, 'documentServerUrl' | 'config'>;

export function OfficePreview({ id, onAccessLost }: { id: string; onAccessLost?: (status: number) => void }) {
  const [session, setSession] = useState<Session>();
  const accessLost = useRef(onAccessLost);
  useEffect(() => { accessLost.current = onAccessLost; }, [onAccessLost]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void sessionFetch(`/v1/assets/${encodeURIComponent(id)}/office-session`, { signal: controller.signal }).then(async response => {
      if (controller.signal.aborted) return;
      if ([401, 403, 404].includes(response.status)) accessLost.current?.(response.status);
      if (!response.ok) throw new Error('office_session_unavailable');
      const next: Session = await response.json();
      if (!controller.signal.aborted) setSession(next);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [id]);
  if (failed) return <div className="asset-viewer-fallback" role="status">Office preview unavailable. Download the original to open this file.</div>;
  if (!session) return <p className="asset-viewer-loading" role="status">Opening document…</p>;
  return <div className="asset-office-preview" role="region" aria-label="Office document viewer" aria-busy={!ready}>
    <DocumentEditor id={`office-${id}`} {...session} events_onDocumentReady={() => setReady(true)} events_onError={() => setFailed(true)} onLoadComponentError={() => setFailed(true)} />
  </div>;
}
