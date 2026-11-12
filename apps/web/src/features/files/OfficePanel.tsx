import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HubFile, Page } from '@space/contracts';
import { Button } from '@space/ui/primitives';
import { FileText } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { OfficePreview, type OfficeExit } from './OfficePreview.js';
import './asset-attachments.css';
import './office-panel.css';

function OfficeLibrary({ workspace }: { workspace: string }) {
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState('');
  const [page, setPage] = useState<Page<HubFile>>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPage(undefined);
    setError('');
    const params = new URLSearchParams({ kind: 'other', q: search.trim(), limit: '50' });
    if (cursor) params.set('after', cursor);
    const timeout = setTimeout(() => {
      void request<Page<HubFile>>(`/workspaces/${workspace}/hub/files?${params}`, undefined, undefined, undefined, controller.signal)
        .then(result => { if (!controller.signal.aborted) setPage(result); })
        .catch(() => { if (!controller.signal.aborted) setError('Could not load files.'); });
    }, search ? 180 : 0);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [workspace, search, cursor, retry]);
  const files = page?.items.filter(file => file.preview_kind === 'office' ||
    (file.preview_kind === 'file' && /\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(file.filename)));
  return <main className="office-panel office-library">
    <h1>Office editor</h1>
    <input type="search" aria-label="Search Office files" placeholder="Search files" maxLength={255} value={search}
      onChange={event => { setCursor(''); setSearch(event.target.value); }} />
    {error && <p role="alert">{error} <Button onClick={() => setRetry(n => n + 1)}>Try again</Button></p>}
    {!page && !error && <p role="status">Loading files…</p>}
    {files && !files.length && <p role="status">{page?.next_cursor ? 'No Office files on this page.' : 'No matching Office files.'}</p>}
    <ul>{files?.map(file => <li key={file.id}><a href={'/office/file/' + file.id} onClick={event => {
      if (!window.spaceOffice) return;
      event.preventDefault();
      void window.spaceOffice.openFile(file.id).then(ok => { if (!ok) setError('Could not open file.'); })
        .catch(() => setError('Could not open file.'));
    }}><FileText size={22} /><span>{file.filename}<small>{file.channel_name}</small></span></a></li>)}</ul>
    <div>{cursor && <Button variant="ghost" onClick={() => setCursor('')}>First page</Button>}
      {page?.next_cursor && <Button variant="ghost" onClick={() => setCursor(page.next_cursor!)}>Next page</Button>}</div>
  </main>;
}

export default function OfficePanel({ id, library }: { id: string; library: boolean }) {
  const exit: OfficeExit = useRef(null);
  const [title, setTitle] = useState('Office editor');
  useLayoutEffect(() => {
    const update = () => { document.documentElement.dataset.theme = localStorage.getItem('space-theme') === 'light' ? 'light' : 'dark'; };
    update();
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  useEffect(() => { document.title = title; }, [title]);
  useEffect(() => window.spaceOffice?.onClose(leave => { if (exit.current) exit.current(leave); else leave(); }), []);
  if (library) return <OfficeLibrary workspace={id} />;
  return <main className="office-panel"><h1>{title}</h1><OfficePreview id={id} exit={exit} onTitle={setTitle} /></main>;
}
