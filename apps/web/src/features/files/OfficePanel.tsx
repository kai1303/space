import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HubFile, Page } from '@space/contracts';
import { Button, ListRowSkeleton } from '@space/ui/primitives';
import { FileText } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { OfficePreview, type OfficeExit } from './OfficePreview.js';
import './asset-attachments.css';
import { useFilePickerPage } from './useFilePickerPage.js';
import './office-panel.css';

function OfficeLibrary({ workspace }: { workspace: string }) {
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState('');
  const [openError, setOpenError] = useState('');
  const list = useCallback((params: URLSearchParams, signal: AbortSignal) =>
    request<Page<HubFile>>(`/workspaces/${workspace}/hub/files?${params}`, undefined, undefined, undefined, signal), [workspace]);
  const query = new URLSearchParams({ kind: 'other', q: search.trim(), limit: '50' }).toString();
  const {page, displayedCursor, changingPage, error, retry} = useFilePickerPage(list, query, cursor, search.trim() ? 180 : 0);
  const files = page?.items.filter(file => file.preview_kind === 'office' ||
    (file.preview_kind === 'file' && /\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(file.filename)));
  return <main className="office-panel office-library">
    <h1>Office editor</h1>
    <input type="search" aria-label="Search Office files" placeholder="Search files" maxLength={255} value={search}
      onChange={event => { setOpenError(''); setCursor(''); setSearch(event.target.value); }} />
    {error && <p role="alert">{error} <Button onClick={retry}>Try again</Button></p>}
    {!page && !error && <ListRowSkeleton label="Loading files…"/>}
    {files && !files.length && <p role="status">{page?.next_cursor ? 'No Office files on this page.' : 'No matching Office files.'}</p>}
    {openError && <p role="alert">{openError}</p>}
    <ul>{files?.map(file => <li key={file.id}><a href={'/office/file/' + file.id} onClick={event => {
      if (!window.spaceOffice) return;
      event.preventDefault();
      setOpenError('');
      void window.spaceOffice.openFile(file.id).then(ok => { if (!ok) setOpenError('Could not open file.'); })
        .catch(() => setOpenError('Could not open file.'));
    }}><FileText size={22} /><span>{file.filename}<small>{file.channel_name}</small></span></a></li>)}</ul>
    <div>{(displayedCursor || cursor) && <Button variant="ghost" loading={changingPage && !cursor} onClick={() => !cursor && error ? retry() : setCursor('')}>First page</Button>}
      {page?.next_cursor && <Button variant="ghost" loading={changingPage && !!cursor} onClick={() => cursor === page.next_cursor && error ? retry() : setCursor(page.next_cursor!)}>Next page</Button>}</div>
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
  if (library) return <OfficeLibrary key={id} workspace={id} />;
  return <main className="office-panel"><h1>{title}</h1><OfficePreview key={id} id={id} exit={exit} onTitle={setTitle} /></main>;
}
