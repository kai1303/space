import { messagePath } from '@space/contracts';
import { useEffect, useRef, useState } from 'react';
import { HUB_FILE_KINDS, type HubFile, type Page, type WorkspaceParticipant, type ChannelSummary } from '@space/contracts';
import { Tabs, Select, Button, Dialog, IconButton, Menu, MultiSelectMenu } from '@space/ui/primitives';
import { NavigationIcon } from '@space/ui/navigation';
import { DotsThreeVertical, DownloadSimple, File, FileCode, FilePdf, ImageSquare, MagnifyingGlass, MusicNote, SlidersHorizontal, Star, VideoCamera, X } from '@phosphor-icons/react';
import { AssetViewer } from './AssetAttachments.js';
import { request } from '../../shared/api/request.js';
import { MAX_ITEMS, useCollection } from '../workspace/collections/useWorkspaceCollection.js';
import './workspace-files.css';

type Props = { workspace: string; onOpen: (target: { channel_id: string; message_id?: string }) => void };
type Filters = { from: string; channel: string; since: string; before: string };
const emptyFilters: Filters = { from: '', channel: '', since: '', before: '' };
const kinds = [
  { value: 'image', label: 'Images', icon: <ImageSquare /> },
  { value: 'pdf', label: 'PDFs', icon: <FilePdf /> },
  { value: 'text', label: 'Text & snippets', icon: <FileCode /> },
  { value: 'audio', label: 'Audio', icon: <MusicNote /> },
  { value: 'video', label: 'Videos', icon: <VideoCamera /> },
  { value: 'other', label: 'Other files', icon: <File /> },
];
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const assetUrl = (id: string, action: string) => `/v1/assets/${encodeURIComponent(id)}/${action}`;

export function WorkspaceFiles({ workspace, onOpen }: Props) {
  const [view, setView] = useState('all'), [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [ownership, setOwnership] = useState('all'), [selectedKinds, setSelectedKinds] = useState<string[]>([...HUB_FILE_KINDS]), [sort, setSort] = useState('recent');
  const [filters, setFilters] = useState<Filters>(emptyFilters), [filterOpen, setFilterOpen] = useState(false);
  useEffect(() => { const timeout = window.setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timeout); }, [search]);
  const params = new URLSearchParams({ q: query, ownership, kinds: selectedKinds.join(','), sort, starred: String(view === 'starred') });
  if (filters.from) params.set('from', filters.from);
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.since) params.set('since', new Date(`${filters.since}T00:00:00`).toISOString());
  if (filters.before) { const end = new Date(`${filters.before}T00:00:00`); end.setDate(end.getDate() + 1); params.set('before', end.toISOString()); }
  const filterCount = Number(!!filters.from) + Number(!!filters.channel) + Number(!!(filters.since || filters.before));
  const filtered = !!query || ownership !== 'all' || selectedKinds.length !== HUB_FILE_KINDS.length || filterCount > 0;
  function clear() { setSearch(''); setQuery(''); setOwnership('all'); setSelectedKinds([...HUB_FILE_KINDS]); setFilters(emptyFilters); }
  return <main id="chat-messages" tabIndex={-1} className="workspace-files">
    <nav className="files-sidebar" aria-label="Files navigation"><h2>Files</h2>
      <button type="button" aria-current={view === 'all' ? 'page' : undefined} onClick={() => setView('all')}><NavigationIcon name="files" size={18} />All files</button>
      <div className="files-sidebar-divider" />
      <button type="button" aria-current={view === 'starred' ? 'page' : undefined} onClick={() => setView('starred')}><Star size={18} />Starred</button>
      <p>Star a file to keep it close at hand.</p>
    </nav>
    <section className="files-main" aria-label="Files">
      <header className="files-heading"><div className="files-width"><h1>{view === 'starred' ? 'Starred' : 'All files'}</h1><div className="files-search"><MagnifyingGlass size={20} aria-hidden="true" /><input type="search" aria-label="Search files" placeholder="Search files" maxLength={255} value={search} onChange={event => setSearch(event.target.value)} />{search && <IconButton label="Clear search" size="sm" onClick={() => { setSearch(''); setQuery(''); }}><X size={16} /></IconButton>}</div></div></header>
      <div className="files-body files-width">
        <div className="files-toolbar"><Tabs className="files-ownership" label="File ownership" value={ownership} onChange={setOwnership} items={[{id:'all',label:'All'},{id:'created',label:'Created by you'},{id:'shared',label:'Shared with you'}]}/>
          <div className="files-tools"><MultiSelectMenu label="File types" summary={`${selectedKinds.length} ${selectedKinds.length === 1 ? 'Type' : 'Types'}`} options={kinds} value={selectedKinds} onChange={setSelectedKinds} /><Select aria-label="Sort files" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Recently viewed</option><option value="newest">Newest shared</option><option value="oldest">Oldest shared</option></Select><Button size="sm" aria-label="Filters" aria-haspopup="dialog" onClick={() => setFilterOpen(true)}><SlidersHorizontal size={18} />{filterCount > 0 && <span>{filterCount}</span>}</Button></div>
        </div>
        {filtered && <div className="files-active-filters"><span>Filtered files</span><button type="button" onClick={clear}>Clear filters</button></div>}
        <FileResults key={params.toString()} workspace={workspace} onOpen={onOpen} query={params.toString()} filtered={filtered} starred={view === 'starred'} clear={clear} onRevoked={() => setFilterOpen(false)} />
      </div>
    </section>
    {filterOpen && <FileFilters workspace={workspace} value={filters} onClose={() => setFilterOpen(false)} onApply={value => { setFilters(value); setFilterOpen(false); }} />}
  </main>;
}

function FileThumbnail({ file }: { file: HubFile }) {
  const [failed, setFailed] = useState(false);
  const Icon = file.preview_kind === 'pdf' ? FilePdf : file.preview_kind === 'text' ? FileCode : file.preview_kind === 'audio' ? MusicNote : file.preview_kind === 'video' ? VideoCamera : File;
  return <span className={`files-thumbnail files-thumbnail--${file.preview_kind}`}>{file.preview_kind === 'image' && !failed ? <img src={assetUrl(file.id,'thumbnail')} alt="" loading="lazy" onError={() => setFailed(true)} /> : <Icon size={25} aria-hidden="true" />}</span>;
}
function FileResults({ workspace, onOpen, query, filtered, starred, clear, onRevoked }: Props & { query: string; filtered: boolean; starred: boolean; clear: () => void; onRevoked: () => void }) {
  const data = useCollection(workspace, 'files', query);
  const files = data.items as HubFile[];
  useEffect(() => { if (data.revoked) onRevoked(); }, [data.revoked, onRevoked]);
  const [preview, setPreview] = useState<string | null>(null), [details, setDetails] = useState<string | null>(null), [copied, setCopied] = useState('');
  const opener = useRef<HTMLElement | null>(null), viewerOrder = useRef<string[]>([]), recordedView = useRef<string | null>(null);
  useEffect(() => {
    if (!preview || data.busy || data.revoked || recordedView.current === preview || !files.some(file => file.id === preview)) return;
    recordedView.current = preview;
    void data.change(`/files/${encodeURIComponent(preview)}/view`, {});
  }, [preview, data.busy, data.revoked, data.change, files]);
  function show(file: HubFile, element?: HTMLElement) {
    opener.current = element ?? document.activeElement as HTMLElement;
    viewerOrder.current = files.map(item => item.id); recordedView.current = null; setPreview(file.id);
  }
  function closePreview() { setPreview(null); queueMicrotask(() => opener.current?.isConnected && opener.current.focus()); }
  async function copy(file: HubFile) {
    try { await navigator.clipboard.writeText(`${location.origin}${messagePath(file.channel_id, file.message_id)}`); setCopied('Message link copied. Only people with access to the conversation can open it.'); }
    catch { setCopied('Could not copy the link. Open the source message to try again.'); }
  }
  const current = files.find(file => file.id === details);
  const previewFiles = viewerOrder.current.flatMap(id => files.find(file => file.id === id) ?? []);
  return <>
    {data.error && <div className="files-error"><p role="alert">{data.error}</p>{!data.revoked && <Button size="sm" onClick={() => void data.retry()}>Retry</Button>}</div>}
    {data.writeError && <p className="files-error" role="alert">{data.writeError}. Your change could not be confirmed. Try again.</p>}
    {copied && <p className="files-status" role="status">{copied}</p>}
    <div aria-busy={data.loading}>
      {!data.loading && !data.error && !files.length && <div className="files-empty"><NavigationIcon name={starred ? 'star' : 'files'} size={42} /><h2>{filtered ? 'No files match your filters' : starred ? 'Your important files, together' : 'No files shared yet'}</h2><p>{filtered ? 'Try another search, file type, person or conversation.' : starred ? 'Star files from All files and find them here whenever you need them.' : 'Upload a file in a conversation. Files shared in conversations you can access will appear here.'}</p>{filtered && <Button size="sm" onClick={clear}>Clear all filters</Button>}</div>}
      <ul className="files-list" aria-label="Files results">{files.map(file => <li key={file.id} className="files-row">
        <button className="files-open" type="button" aria-label={`Preview ${file.filename}`} disabled={data.busy} onClick={event => show(file, event.currentTarget)}><FileThumbnail file={file} /><span className="files-info"><strong>{file.filename}</strong><span>{file.uploader_name || 'Workspace member'} · {file.channel_name} · {file.last_viewed_at ? `Last viewed ${date(file.last_viewed_at)}` : `Shared ${date(file.created_at)}`}</span></span></button>
        <div className="files-row-actions"><IconButton size="sm" label={`${file.starred ? 'Unstar' : 'Star'} ${file.filename}`} aria-pressed={!!file.starred} disabled={data.busy || data.revoked} onClick={() => void data.change(`/files/${encodeURIComponent(file.id)}/star`, { active: !file.starred })}><Star size={18} weight={file.starred ? 'fill' : 'regular'} /></IconButton>
          <a className="files-download" aria-label={`Download ${file.filename}`} title="Download" href={assetUrl(file.id,'download')}><DownloadSimple size={18} /></a>
          <Menu label={`More actions for ${file.filename}`} trigger={<DotsThreeVertical size={20} />} floating items={[
            { label: 'View file details', onSelect: () => setDetails(file.id) },
            { label: 'View message', onSelect: () => onOpen({ channel_id: file.channel_id, message_id: file.message_id }) },
            { label: 'Copy message link', onSelect: () => void copy(file) },
          ]} />
        </div>
      </li>)}</ul>
    </div>
    {data.loading && <p className="files-status" role="status">Loading files…</p>}
    {!data.loading && !data.error && data.cursor && <div className="files-more">{files.length < MAX_ITEMS ? <Button size="sm" disabled={data.busy} onClick={() => void data.more()}>Load more</Button> : <p>Showing {MAX_ITEMS} files. Search or filter to find more.</p>}</div>}
    {preview && files.some(file => file.id === preview) && <AssetViewer assets={previewFiles.map(file => ({ id: file.id, name: file.filename, size: file.byte_size, type: file.content_type, description: file.description }))} selectedId={preview} onSelect={setPreview} onClose={closePreview} onAccessLost={() => { setPreview(null); setDetails(null); void data.clearAndRefresh(); }} previews={Object.fromEntries(files.map(file => [file.id,{ kind: (['image','pdf','text','audio','video','unsupported'].includes(file.preview_kind) ? file.preview_kind : 'file') as 'image'|'pdf'|'text'|'audio'|'video'|'unsupported'|'file' }]))} />}
    {current && <Dialog open title="File details" onClose={() => setDetails(null)}><div className="files-detail"><FileThumbnail file={current} /><h3>{current.filename}</h3><dl><dt>Shared by</dt><dd>{current.uploader_name}</dd><dt>Conversation</dt><dd>{current.channel_name}</dd><dt>Shared</dt><dd>{date(current.created_at)}</dd><dt>Type</dt><dd>{current.content_type}</dd><dt>Size</dt><dd>{new Intl.NumberFormat().format(current.byte_size)} bytes</dd></dl><div><Button size="sm" onClick={() => { setDetails(null); show(current); }}>Open file</Button><Button size="sm" onClick={() => onOpen({ channel_id: current.channel_id, message_id: current.message_id })}>View message</Button><a href={assetUrl(current.id,'download')}>Download</a></div></div></Dialog>}
  </>;
}

function DirectorySelect({ workspace, resource, value, onChange }: { workspace: string; resource: 'participants'|'channels'; value: string; onChange: (value: string) => void }) {
  const [items,setItems] = useState<{id:string;name:string}[]>([]), [cursor,setCursor] = useState<string|null>(null), [loading,setLoading] = useState(false), [error,setError] = useState('');
  const requestRef = useRef<AbortController | null>(null), retry = useRef<string | undefined>(undefined);
  async function load(after?: string) {
    requestRef.current?.abort(); const controller = new AbortController(); requestRef.current = controller; retry.current = after; setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
      const page = await request<Page<WorkspaceParticipant|ChannelSummary>>(`/workspaces/${encodeURIComponent(workspace)}/${resource}?${params}`,undefined,undefined,'POST',controller.signal);
      if (controller.signal.aborted) return;
      const choices = page.items.filter(item => resource !== 'participants' || item.kind === 'human').map(item => ({ id:item.id,name:item.name }));
      setItems(previous => [...new Map([...(after ? previous : []),...choices].map(item=>[item.id,item])).values()].slice(0,500)); setCursor(page.next_cursor);
    } catch (reason) { if (!controller.signal.aborted) { setItems([]); setCursor(null); setError(reason instanceof Error ? reason.message.replaceAll('_',' ') : 'Unable to load choices'); } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [workspace,resource]);
  return <div><Select searchable aria-label={resource === 'participants' ? 'From' : 'In'} value={value} onChange={event=>onChange(event.target.value)}><option value="">{resource === 'participants' ? 'Anyone' : 'Any conversation'}</option>{value && !items.some(item=>item.id===value) && <option value={value}>Selected {resource === 'participants' ? 'person' : 'conversation'}</option>}{items.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select>{loading && <small role="status">Loading choices…</small>}{error && <><p role="alert">{error}</p><Button size="sm" onClick={()=>void load(retry.current)}>Retry choices</Button></>}{cursor && items.length < 500 && <Button size="sm" disabled={loading} onClick={()=>void load(cursor)}>Load more {resource === 'participants' ? 'people' : 'conversations'}</Button>}{cursor && items.length >= 500 && <small>Showing the first 500 choices.</small>}</div>;
}
function FileFilters({ workspace, value, onClose, onApply }: { workspace: string; value: Filters; onClose: () => void; onApply: (value: Filters) => void }) {
  const [draft,setDraft] = useState(value);
  const invalid = !!(draft.since && draft.before && draft.since > draft.before);
  return <Dialog open title="Filter by" onClose={onClose}><form className="files-filter-dialog" onSubmit={event => { event.preventDefault(); if (!invalid) onApply(draft); }}>
    <label>From<DirectorySelect workspace={workspace} resource="participants" value={draft.from} onChange={from=>setDraft({...draft,from})} /></label>
    <label>In<DirectorySelect workspace={workspace} resource="channels" value={draft.channel} onChange={channel=>setDraft({...draft,channel})} /></label>
    <fieldset><legend>Date shared</legend><label>From date<input type="date" value={draft.since} onChange={event=>setDraft({...draft,since:event.target.value})} /></label><label>Through date<input type="date" value={draft.before} onChange={event=>setDraft({...draft,before:event.target.value})} /></label></fieldset>
    {invalid && <p role="alert">The end date must be on or after the start date.</p>}
    <footer><Button size="sm" onClick={()=>setDraft(emptyFilters)}>Clear filters</Button><Button variant="primary" size="sm" type="submit" disabled={invalid}>Done</Button></footer>
  </form></Dialog>;
}
