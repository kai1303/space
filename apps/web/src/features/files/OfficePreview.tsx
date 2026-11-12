import { useEffect, useRef, useState, type RefObject } from 'react';
import { DocumentEditor, type DocumentEditorProps } from '@onlyoffice/document-editor-react';
import { Button } from '@space/ui/primitives';
import { DownloadSimple, PencilSimple, Users } from '@phosphor-icons/react';
import { OfficeAgent } from './OfficeAgent.js';
import { sessionFetch } from '../../shared/api/session-fetch.js';

type Session = Pick<DocumentEditorProps, 'documentServerUrl' | 'config'> & {
  canEdit: boolean; canShare: boolean; channelEditing: boolean; revision: number;
};

export type OfficeExit = RefObject<((leave: () => void) => void) | null>;
export function OfficePreview({ id, exit, onAccessLost, onTitle }: { id: string; onTitle?: (title: string) => void; exit: OfficeExit; onAccessLost?: (status: number) => void }) {
  const [session, setSession] = useState<Session>();
  const accessLost = useRef(onAccessLost);
  useEffect(() => { accessLost.current = onAccessLost; }, [onAccessLost]);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const afterClose = useRef<() => void>(undefined);
  useEffect(() => {
    if (!editing || !ready) return;
    exit.current = leave => {
      const editor = window.DocEditor?.instances[`office-${id}`];
      if (!editor) return leave();
      afterClose.current = leave;
      editor.requestClose();
    };
    return () => { exit.current = null; afterClose.current = undefined; };
  }, [editing, ready, exit, id]);
  const [notice, setNotice] = useState('');
  const base = `/v1/assets/${encodeURIComponent(id)}`;
  useEffect(() => {
    const controller = new AbortController();
    setSession(undefined);
    setReady(false);
    setFailed(false);
    const headers = { ...(editing && window.spaceOffice?.ask && { 'x-space-office-agent': 'selection' }), 'x-space-theme': document.documentElement.dataset.theme ?? 'light' };
    void sessionFetch(base + '/office-session' + (editing ? '?mode=edit' : ''), { signal: controller.signal, headers }).then(async response => {
      if (controller.signal.aborted) return;
      if (editing && response.status === 403) {
        setNotice('You no longer have permission to edit this file.');
        setEditing(false);
        return;
      }
      if ([401, 403, 404].includes(response.status)) accessLost.current?.(response.status);
      if (!response.ok) throw new Error();
      const next: Session = await response.json();
      if (!controller.signal.aborted) {
        setSession(next);
        if (next.config.document?.title) onTitle?.(next.config.document.title);
      }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [base, editing, onTitle]);

  async function changeSharing() {
    if (!session || sharing) return;
    setSharing(true);
    setNotice('');
    try {
      const enabled = !session.channelEditing;
      const response = await sessionFetch(base + '/office-sharing', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error();
      setSession(current => current && { ...current, channelEditing: enabled });
    } catch { setNotice('Could not change channel editing. Try again.'); }
    finally { setSharing(false); }
  }

  if (failed) return <div className="asset-viewer-fallback" role="alert">Could not open this document. <a href={base + '/download'}>Download file</a></div>;
  if (!session) return <p className="asset-viewer-loading" role="status">Opening document…</p>;
  return <>
    <div className="asset-office-tools">
      <span className="asset-office-mode">{editing ? 'Editing' : 'Viewing'} · Version {session.revision + 1}</span>
      <div className="asset-office-actions">
        {session.canShare && !editing && <Button variant="ghost" disabled={sharing} aria-pressed={session.channelEditing}
          title="Allow channel members with posting permission to edit this file" onClick={() => void changeSharing()}>
          <Users size={16} />Channel editing {session.channelEditing ? 'on' : 'off'}
        </Button>}
        {editing && window.spaceOffice?.ask && session.config.documentType === 'word' && session.config.document?.key &&
          <OfficeAgent key={session.config.document.key} sessionKey={session.config.document.key} editorId={`office-${id}`} serverUrl={session.documentServerUrl} />}
        <a className="sp-button sp-button--secondary sp-button--sm" href={base + '/download'}><DownloadSimple size={16}/>Download</a>
        {session.revision > 0 && <a href={base + '/download?original=1'}>Original upload</a>}
        {session.canEdit && !editing && <Button onClick={() => { setNotice(''); setEditing(true); }}><PencilSimple size={16} />Edit</Button>}
      </div>
    </div>
    {editing && <p className="asset-office-status">{dirty ? 'Syncing changes…' : 'Changes are saved to Space when the last editor closes the document.'}</p>}
    {notice && <p className="asset-office-status" role="status">{notice}</p>}
    <div className="asset-office-preview" data-office-editor={`office-${id}`} role="region" aria-label={editing ? 'Office document editor' : 'Office document viewer'} aria-busy={!ready}>
      <DocumentEditor id={`office-${id}`} documentServerUrl={session.documentServerUrl} config={{ ...session.config, events: {
          onDocumentReady: () => setReady(true),
          onDocumentStateChange: event => setDirty(event.data === true),
          onRequestClose: () => afterClose.current?.(),
          onError: () => setNotice('The document service reported an error. Check the editor before closing.'),
        } }}
        onLoadComponentError={() => setFailed(true)} />
    </div>
  </>;
}
