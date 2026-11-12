import { sessionFetch } from '../../shared/api/session-fetch.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChannelFile, Page } from '@space/contracts';
import { Select, Button, IconButton, SidePanel } from '@space/ui/primitives';
import { ArrowClockwise, File, FileCode, FilePdf, MusicNote, VideoCamera, X } from '@phosphor-icons/react';
import { AssetViewer } from './AssetAttachments.js';
import './channel-files.css';

type Props = { direct?: boolean; channel: string; name: string; revision?: string; deletions?: { current: ((ids: ReadonlySet<string>) => void) | null }; onClose: () => void; onMessage: (messageId: string) => void; onAccessLost?: () => void };
const kinds = [['all', 'All files'], ['image', 'Images'], ['pdf', 'PDFs'], ['text', 'Text'], ['audio', 'Audio'], ['video', 'Videos'], ['other', 'Other']] as const;
const assetUrl = (id: string, action: string) => `/v1/assets/${encodeURIComponent(id)}/${action}`;
function FileThumbnail({ file }: { file: ChannelFile }) {
  const [failed, setFailed] = useState(false);
  const Icon = file.preview_kind === 'pdf' ? FilePdf : file.preview_kind === 'text' ? FileCode : file.preview_kind === 'audio' ? MusicNote : file.preview_kind === 'video' ? VideoCamera : File;
  return <span className={`channel-file-thumbnail channel-file-thumbnail--${file.preview_kind}`}>
    {file.preview_kind === 'image' && !failed ? <img src={assetUrl(file.id, 'thumbnail')} alt="" loading="lazy" onError={() => setFailed(true)} /> : <Icon size={28} aria-hidden="true" />}
  </span>;
}

// A channel change remounts all private state before another channel can paint.
export function ChannelFiles(props: Props) { return <ChannelFilesPanel key={props.channel} {...props} />; }
function ChannelFilesPanel({ direct, channel, name, revision, deletions, onClose, onMessage, onAccessLost }: Props) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState('newest');
  const [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<ChannelFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [appliedRevision, setAppliedRevision] = useState(revision);
  useEffect(() => { if (!selected) setAppliedRevision(revision); }, [revision, selected]);
  const searchInput = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const accessLost = useRef(onAccessLost);
  useLayoutEffect(() => { accessLost.current = onAccessLost; }, [onAccessLost]);
  useEffect(() => { searchInput.current?.focus(); }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || (event.target as HTMLElement).closest('dialog')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  useLayoutEffect(() => {
    if (!deletions) return;
    deletions.current = ids => {
      // An open viewer defers the list refresh; discard any older pagination response.
      if (selected) { request.current?.abort(); setLoading(false); }
      if (items.some(file => file.id === selected && ids.has(file.message_id))) setSelected(null);
      setItems(current => current.filter(file => !ids.has(file.message_id)));
    };
    return () => { deletions.current = null; };
  }, [deletions, items, selected]);

  function expireSession() {
    request.current?.abort();
    setItems([]); setCursor(null); setSelected(null); setLoading(false);
    setError('Your session has expired.');
  }
  useEffect(() => {
    window.addEventListener('space:session-expired', expireSession);
    return () => window.removeEventListener('space:session-expired', expireSession);
  }, []);
  function load(after?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    if (!after) { setItems([]); setCursor(null); setSelected(null); }
    const params = new URLSearchParams({ q: query, kind, sort, limit: '24' });
    if (after) params.set('after', after);
    void sessionFetch(`/v1/channels/${encodeURIComponent(channel)}/assets?${params}`, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
      if (controller.signal.aborted) return;
      if ([401, 403, 404].includes(response.status)) {
        setItems([]); setCursor(null); setSelected(null);
        if (response.status === 401) window.dispatchEvent(new Event('space:session-expired'));
        else accessLost.current?.();
        throw new Error(response.status === 401 ? 'Your session has expired.' : 'You no longer have access to these files.');
      }
      if (!response.ok) throw new Error('Could not load files. Try again.');
      const page = await response.json() as Page<ChannelFile>;
      if (controller.signal.aborted) return;
      if (!Array.isArray(page.items)) throw new Error('Could not load files. Try again.');
      setItems(previous => [...new Map([...(after ? previous : []), ...page.items].map(file => [file.id, file])).values()]);
      setCursor(page.next_cursor);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load files. Try again.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }
  useLayoutEffect(() => {
    load();
    return () => request.current?.abort();
  }, [channel, query, kind, sort, appliedRevision, refresh]);
  function handlePreviewAccessLoss(status: number) {
    if (status === 401) { expireSession(); return; }
    // A file can disappear while its channel is still accessible. The list checks membership.
    load();
    searchInput.current?.focus();
  }
  function closeViewer() { setSelected(null); queueMicrotask(() => { if (revision === appliedRevision && opener.current?.isConnected) opener.current.focus(); else searchInput.current?.focus(); }); }
  const filtered = !!query || kind !== 'all';
  return <SidePanel className="channel-files" role="region" aria-label={`Files in ${direct ? '' : '#'}${name}`}>
    <header className="channel-files-header"><h2>Files</h2><IconButton label="Close files" onClick={onClose}><X size={20} /></IconButton></header>
    <div className="channel-files-controls">
      <input ref={searchInput} type="search" aria-label="Search filenames" placeholder="Search filenames" maxLength={255} value={search} onChange={event => setSearch(event.target.value)} />
      <div className="channel-files-filters">
        <label>File type<Select aria-label="File type" value={kind} onChange={event => setKind(event.target.value)}>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
        <label>Sort files<Select aria-label="Sort files" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Newest shared</option><option value="oldest">Oldest shared</option></Select></label>
        <IconButton label="Refresh files" disabled={loading} onClick={() => setRefresh(value => value + 1)}><ArrowClockwise size={20} /></IconButton>
      </div>
    </div>
    <div className="channel-files-body" aria-busy={loading}>
      {error && <div className="channel-files-state"><p role="alert">{error}</p><Button variant="secondary" onClick={() => load(items.length ? cursor ?? undefined : undefined)}>Retry</Button></div>}
      {!error && !loading && !items.length && <div className="channel-files-state"><File size={40} aria-hidden="true" /><h3>{filtered ? 'No files match your filters' : 'No files shared yet'}</h3><p>{filtered ? 'Try a different filename or file type.' : 'Files shared in this channel and its threads will appear here.'}</p></div>}
      {!!items.length && <ul className="channel-files-list">{items.map(file => <li key={file.id} className="channel-file-row">
        <FileThumbnail file={file} />
        <div className="channel-file-info"><span className="channel-file-name" title={file.name}>{file.name}</span><span className="channel-file-detail">{Math.max(1, Math.round(file.size / 1024))} KB · {file.uploader.name}</span><time dateTime={file.shared_at}>{new Date(file.shared_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
          <div className="channel-file-actions"><button type="button" aria-label={`Preview ${file.name}`} onClick={event => { opener.current = event.currentTarget; setSelected(file.id); }}>Preview</button><a href={assetUrl(file.id, 'download')} aria-label={`Download ${file.name}`}>Download</a><button type="button" aria-label={`View message for ${file.name}`} onClick={() => onMessage(file.message_id)}>View message</button></div>
        </div>
      </li>)}</ul>}
      {loading && <p className="channel-files-loading" role="status">Loading files…</p>}
      {!loading && !error && cursor && <div className="channel-files-more"><Button variant="secondary" onClick={() => load(cursor)}>Load more</Button></div>}
    </div>
    {selected && <AssetViewer channelLabel={direct ? name : `#${name}`} assets={items} selectedId={selected} onSelect={setSelected} onClose={closeViewer} onAccessLost={handlePreviewAccessLoss} previews={Object.fromEntries(items.map(file => [file.id, { kind: file.preview_kind }]))} />}
  </SidePanel>;
}
