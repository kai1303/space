import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { VideoClipPlayer } from './VideoClipPlayer.js';
import { VoiceClipPlayer } from './VoiceClipPlayer.js';
import { FileDetailsForm } from './FileDetailsForm.js';
import { sessionFetch } from '../../shared/api/session-fetch.js';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { conversationPath, type AssetAttachment, type AssetDetails, type AssetPreview } from '@space/contracts';
import { Button, Dialog, IconButton, ImageStage, Menu } from '@space/ui/primitives';
import { AgentMarkdown } from '@space/ui/agents';
import { CodeBlock } from '@space/ui/rich-text';
import { ArrowLeft, ArrowRight, ArrowSquareOut, ChatCircle, CloudArrowDown, DotsThree, DownloadSimple, Eye, File, FileCode, FileDoc, FilePdf, FilePpt, FileXls, PencilSimple, MusicNote, SidebarSimple, VideoCamera } from '@phosphor-icons/react';
import type { OfficeExit } from './OfficePreview.js';
import { imageGalleryLayout, type GalleryTile } from './imageGalleryLayout.js';
import './asset-attachments.css';

const OfficePreview = lazy(() => import('./OfficePreview.js').then(module => ({ default: module.OfficePreview })));
const PdfPreview = lazy(() => import('./PdfPreview.js').then(module => ({ default: module.PdfPreview })));
const assetUrl = (id: string, action: string) => `/v1/assets/${encodeURIComponent(id)}/${action}`;
const sharedAt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
function usePreview(id: string, onAccessLost?: (status: number) => void, withDetails = false) {
  const accessLost = useRef(onAccessLost);
  useEffect(() => { accessLost.current = onAccessLost; }, [onAccessLost]);
  const [state, setState] = useState<{ id: string; preview?: AssetPreview; details?: AssetDetails; failed?: boolean }>({ id });
  useEffect(() => {
    const controller = new AbortController();
    setState({ id });
    void sessionFetch(assetUrl(id, 'preview'), { credentials: 'same-origin', signal: controller.signal, headers: withDetails ? { 'x-space-file-details': '1' } : undefined }).then(async response => {
      if (controller.signal.aborted) return;
      if (response.status === 401) window.dispatchEvent(new Event('space:session-expired'));
      if ([401, 403, 404].includes(response.status)) accessLost.current?.(response.status);
      if (!response.ok) throw new Error('Preview unavailable');
      const preview = await response.json() as AssetPreview & { details?: AssetDetails };
      if (!preview || !['image', 'pdf', 'audio', 'video', 'text', 'office', 'unsupported'].includes(preview.kind)) throw new Error('Invalid preview');
      if (!controller.signal.aborted) setState({ id, preview, details: preview.details });
    }).catch(() => { if (!controller.signal.aborted) setState({ id, failed: true }); });
    return () => controller.abort();
  }, [id, withDetails]);
  const channel = state.id === id ? state.details?.channel_id : undefined;
  const readVersion = useRef(0);
  useEffect(() => {
    if (!channel) return;
    const controller = new AbortController();
    const revoke = (status: number) => {
      if (controller.signal.aborted) return;
      setState({ id, failed: true });
      accessLost.current?.(status);
    };
    const stop = subscribeUpdates('channel', channel, async () => {
      const version = ++readVersion.current;
      const response = await sessionFetch(assetUrl(id, 'details'), { signal: controller.signal });
      if ([401, 403, 404].includes(response.status)) return revoke(response.status);
      if (!response.ok) return;
      const details: AssetDetails = await response.json();
      if (!controller.signal.aborted && version === readVersion.current && details.id === id)
        setState(old => old.id === id ? { ...old, details } : old);
    }, code => revoke(code === 'unauthorized' ? 401 : 403));
    return () => { controller.abort(); stop(); };
  }, [channel, id]);
  const saved = (details: AssetDetails) => {
    readVersion.current++;
    setState(old => old.id === details.id ? { ...old, details } : old);
  };
  return { ...(state.id === id ? state : { id }), saved, fail: () => setState({ id, failed: true }) };
}
const officeFormats = {
  docx: ['Word document', FileDoc, 'document'], odt: ['OpenDocument text', FileDoc, 'document'],
  xlsx: ['Excel spreadsheet', FileXls, 'sheet'], ods: ['OpenDocument spreadsheet', FileXls, 'sheet'],
  pptx: ['PowerPoint presentation', FilePpt, 'slides'], odp: ['OpenDocument presentation', FilePpt, 'slides'],
} as const;

function fileTypeLabel(name: string, preview?: AssetPreview) {
  if (preview?.kind === 'office') return officeFormats[preview.fileType][0];
  if (preview?.kind === 'text') return preview.language === 'text' ? 'Text file' : `${preview.language} file`;
  if (preview && preview.kind !== 'unsupported') return { pdf: 'PDF document', image: 'Image', video: 'Video', audio: 'Audio' }[preview.kind];
  const extension = name.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return extension ? `${extension.toUpperCase()} file` : 'File';
}
function FileSymbol({ kind }: { kind?: AssetPreview['kind'] | 'file' }) {
  const Icon = kind === 'pdf' ? FilePdf : kind === 'text' ? FileCode : kind === 'audio' ? MusicNote : kind === 'video' ? VideoCamera : File;
  return <Icon size={28} aria-hidden="true" />;
}
function NativeMedia({ asset, kind, onError }: { asset: AssetAttachment; kind: 'audio' | 'video'; onError: () => void }) {
  const props = { controls: true, preload: 'metadata', src: assetUrl(asset.id, 'content'), onError, 'aria-label': asset.name };
  return kind === 'audio' ? <audio {...props} /> : <video {...props} playsInline />;
}
function imageSources(id: string, preview: Extract<AssetPreview, { kind: 'image' }>, tile?: GalleryTile) {
  if (preview.mime !== 'image/webp' || !tile) return {};
  const { width, height } = preview;
  const thumb = Math.max(1, Math.round(width * Math.min(1, 360 / width, 240 / height)));
  const display = Math.max(1, Math.round(width * Math.min(1, 1600 / width, 1200 / height)));
  if (display <= thumb) return {};
  const fittedWidth = tile.height * width / height;
  const slot = tile.crop ? Math.max(tile.width, fittedWidth) : Math.min(tile.width, fittedWidth);
  return {
    srcSet: `${assetUrl(id, 'thumbnail')} ${thumb}w, ${assetUrl(id, 'content')} ${display}w`,
    sizes: `${Math.ceil(slot)}px`,
  };
}
function AttachmentCard({ asset, tile, hidden, onOpen, onPreview }: { tile?: GalleryTile; hidden: boolean; asset: AssetAttachment; onOpen: (element: HTMLElement) => void; onPreview: (id: string, preview?: AssetPreview) => void }) {
  const { preview, failed, fail } = usePreview(asset.id);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  useEffect(() => {
    onPreview(asset.id, preview);
    return () => onPreview(asset.id);
  }, [asset.id, preview, onPreview]);
  const office = preview?.kind === 'office' ? officeFormats[preview.fileType] : undefined;
  const OfficeIcon = office?.[1];
  if (preview?.kind === 'image') {
    return <div className="asset-card asset-card--image" hidden={hidden} style={tile && { width: tile.width, height: tile.height }}>
      <button type="button" className="asset-image-button" aria-label={tile?.overflow ? `View ${tile.overflow} more images, starting with ${asset.name}` : `Preview ${asset.name}`}
        title={asset.name} onClick={event => onOpen(event.currentTarget)}>
        <img src={assetUrl(asset.id, 'thumbnail')} alt={asset.description || asset.name} width={preview.width} height={preview.height}
          {...imageSources(asset.id, preview, tile)} loading="lazy" className={tile?.crop ? 'asset-image-crop' : undefined} onError={fail} />
        {!!tile?.overflow && <span className="asset-image-overflow" aria-hidden="true">+{tile.overflow}</span>}
      </button>
      {!tile?.overflow && <a className="asset-image-download sp-button sp-button--secondary sp-button--sm sp-icon-button" aria-label={`Download ${asset.name}`} title={`Download ${asset.name}`} href={assetUrl(asset.id, 'download')}><DownloadSimple size={18} /></a>}
    </div>;
  }
  // Older previews can report the shared WebM/MP4 container as video.
  if ((preview?.kind === 'audio' || preview?.kind === 'video' && asset.type.startsWith('audio/')) &&
    /^Audio clip\.(weba|m4a|ogg)$/i.test(asset.name)) {
    return <VoiceClipPlayer src={assetUrl(asset.id, 'content')} name={asset.name}
      download={assetUrl(asset.id, 'download')} onOpen={onOpen} onError={fail}/>;
  }
  const videoClip = preview?.kind === 'video' && /^Video clip\.(webm|mp4)$/i.test(asset.name);
  return <div className="asset-card">
    {videoClip ? <VideoClipPlayer src={assetUrl(asset.id, 'content')} name={asset.name} onError={fail}/> :
      (preview?.kind === 'video' || preview?.kind === 'audio') && <NativeMedia asset={asset} kind={preview.kind} onError={fail} />}
    <div className="asset-card-info">
      <span className={`asset-file-icon asset-file-icon--${office?.[2] ?? preview?.kind ?? 'file'}`}>{OfficeIcon ? <OfficeIcon size={28} aria-hidden="true" /> : <FileSymbol kind={preview?.kind} />}</span>
      <button type="button" className="asset-filename" title={asset.name} aria-label={`Open ${asset.name}`} onClick={event => onOpen(event.currentTarget)}><span>{asset.name}</span><small>{fileTypeLabel(asset.name, preview)} · {Math.max(1, Math.round(asset.size / 1024))} KB</small></button>
      <a className="asset-card-download sp-button sp-button--ghost sp-button--sm sp-icon-button" aria-label={`Download ${asset.name}`} title={`Download ${asset.name}`} href={assetUrl(asset.id, 'download')}><DownloadSimple size={18} aria-hidden="true" /></a>
      {(preview || failed) && preview?.kind !== 'text' && <IconButton label={`Preview ${asset.name}`} size="sm" onClick={event => onOpen(event.currentTarget)}><Eye size={18} aria-hidden="true" /></IconButton>}
    </div>
    {(preview?.kind === 'office' || (preview?.kind === 'pdf' && preview.thumbnail !== false)) && !thumbnailFailed && <button type="button" className={`asset-pdf-thumbnail${office ? ' asset-office-thumbnail' : ''}`} aria-label={`Preview first page of ${asset.name}`} onClick={event => onOpen(event.currentTarget)}>
      <img src={assetUrl(asset.id, 'thumbnail')} alt={`First page of ${asset.name}`} loading="lazy" width={360} height={240} onError={() => setThumbnailFailed(true)} />
    </button>}
    {preview?.kind === 'text' && <div className="asset-snippet"><span className="asset-preview-label">Text preview</span><pre>{preview.text.slice(0, 600).replace(/[\uD800-\uDBFF]$/, '').split('\n').slice(0, 5).join('\n')}</pre><button type="button" className="asset-open-preview" aria-label={`Open preview of ${asset.name}`} onClick={event => onOpen(event.currentTarget)}>Open preview</button></div>}
    {(failed || preview?.kind === 'unsupported') && <p className="asset-unavailable">Preview unavailable</p>}
  </div>;
}
function FilmstripPreview({ asset, preview }: { asset: AssetAttachment; preview?: { kind: AssetPreview['kind'] | 'file' } }) {
  const [failed, setFailed] = useState(false);
  return !failed && preview?.kind === 'image' ? <img src={assetUrl(asset.id, 'thumbnail')} alt="" loading="lazy" onError={() => setFailed(true)} /> : <FileSymbol kind={preview?.kind} />;
}
function TextPreview({ preview }: { preview: Extract<AssetPreview, { kind: 'text' }> }) {
  let code = preview.text.slice(0, 20000).replace(/[\uD800-\uDBFF]$/, '');
  const bytes = new TextEncoder().encode(code);
  if (bytes.length > 32768) code = new TextDecoder().decode(bytes.subarray(0, 32768), { stream: true });
  let lines = 1;
  for (const match of code.matchAll(/\r\n|\r|\n/g)) {
    if (++lines > 1000) { code = code.slice(0, match.index); break; }
  }
  const shortened = code.length < preview.text.length;
  return <div className="asset-text-preview" role="region" aria-label="Text file preview" tabIndex={0}>
    {preview.language === 'markdown' ? <AgentMarkdown text={code} /> : <CodeBlock code={code} language={preview.language} />}
    {(shortened || preview.truncated) && <p role="status">{shortened ? 'Preview shortened to 20,000 characters, 32 KiB, or 1,000 lines.' : 'Showing the first 256 KiB.'} Download to read the complete file.</p>}
  </div>;
}
function DesktopOffice({ id, close, children }: { id: string; close: () => void; children: React.ReactNode }) {
  const request = useRef<Promise<boolean> | undefined>(undefined);
  const finish = useRef(close);
  finish.current = close;
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    let active = true;
    request.current ??= window.spaceDesktop!.openOffice!('file', id);
    void request.current.then(opened => {
      if (active && opened) finish.current();
      else if (active) setFallback(true);
    }).catch(() => { if (active) setFallback(true); });
    return () => { active = false; };
  }, [id]);
  return fallback ? children : <p role="status">Opening in the side panel…</p>;
}
function ViewerContent({ asset, state, exit, close, onAccessLost, actions, initialPage }: {
  initialPage?: number;
  asset: AssetAttachment; state: ReturnType<typeof usePreview>; close: () => void; exit: OfficeExit;
  onAccessLost?: (status: number) => void; actions: React.ReactNode;
}) {
  const { preview, failed, fail } = state;
  if (failed || preview?.kind === 'unsupported') return <div className="asset-viewer-fallback"><File size={56} /><p role="status">Preview unavailable</p><p>Download the original to open this file.</p></div>;
  if (!preview) return <p className="asset-viewer-loading" role="status">Loading preview…</p>;
  const kindLabel = { image: 'Image', pdf: 'PDF', text: 'Text', office: 'Office document', audio: 'Audio', video: 'Video' }[preview.kind];
  let content;
  if (preview.kind === 'image') return <><span className="sp-sr-only">{kindLabel} · {preview.mime}</span><ImageStage src={assetUrl(asset.id, 'original-image')} alt={asset.description || asset.name} onClose={close} onError={fail} actions={actions} /></>;
  else if (preview.kind === 'office') {
    const office = <Suspense fallback={<p role="status">Opening document…</p>}><OfficePreview id={asset.id} exit={exit} onAccessLost={onAccessLost} /></Suspense>;
    return window.spaceDesktop?.openOffice ? <DesktopOffice id={asset.id} close={close}>{office}</DesktopOffice> : office;
  }
  else if (preview.kind === 'pdf') content = <Suspense fallback={<p role="status">Loading PDF viewer…</p>}><PdfPreview assetId={asset.id} size={asset.size} initialPage={initialPage} /></Suspense>;
  else if (preview.kind === 'text') content = <TextPreview preview={preview} />;
  else content = <div className="asset-media-preview"><NativeMedia asset={asset} kind={preview.kind} onError={fail} /></div>;
  return <><p className="asset-preview-type">{kindLabel}{'mime' in preview ? ` · ${preview.mime}` : ''}</p>{content}</>;
}
export function AssetAttachments({ assets }: { assets: AssetAttachment[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, AssetPreview | undefined>>({});
  const rememberPreview = useCallback((id: string, preview?: AssetPreview) => {
    setPreviews(values => {
      if (values[id] === preview) return values;
      const next = { ...values };
      if (preview) next[id] = preview;
      else delete next[id];
      return next;
    });
  }, []);
  const opener = useRef<HTMLElement | null>(null);
  function close() { setSelected(null); queueMicrotask(() => opener.current?.isConnected && opener.current.focus()); }
  const images = assets.filter(asset => previews[asset.id]?.kind === 'image');
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  const hasImages = images.length > 0;
  useEffect(() => {
    const node = container.current;
    if (!hasImages || !node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasImages]);
  const tiles = imageGalleryLayout(images.map(asset => previews[asset.id] as Extract<AssetPreview, { kind: 'image' }>), width);
  const ordered = images.length ? [...images, ...assets.filter(asset => previews[asset.id]?.kind !== 'image')] : assets;
  return <>
    <div ref={container} className={`chat-attachments asset-attachments${hasImages ? ' asset-attachments--gallery' : ''}`} style={hasImages ? { gridTemplateColumns: tiles.map(tile => `minmax(0, ${tile.width}px)`).join(' ') } : undefined} role="group" aria-label="Message attachments">
      {images.length === 1 && assets.length === 1 && <span className="asset-image-caption">{images[0]!.name}</span>}
      {ordered.map((asset, index) => <AttachmentCard key={asset.id} asset={asset} tile={tiles[index]} hidden={index < images.length && index >= tiles.length} onPreview={rememberPreview} onOpen={element => { opener.current = element; setSelected(asset.id); }} />)}</div>
    {selected && <AssetViewer assets={ordered} selectedId={selected} onSelect={setSelected} onClose={close} previews={previews} />}
  </>;
}
export function AssetViewer({ assets, selectedId, onSelect, onClose, onAccessLost, channelLabel, previews = {}, standalone = false, initialPage }: {
  initialPage?: number;
  standalone?: boolean;
  channelLabel?: string;
  assets: AssetAttachment[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  previews?: Record<string, { kind: AssetPreview['kind'] | 'file' } | undefined>;
  onAccessLost?: (status: number) => void;
}) {
  const exit: OfficeExit = useRef(null);
  function leave(action: () => void) { if (exit.current) exit.current(action); else action(); }
  const viewer = useRef<HTMLDivElement>(null);
  const index = assets.findIndex(asset => asset.id === selectedId);
  const state = usePreview(selectedId, onAccessLost, true);
  const details = state.details;
  const asset = assets[index];
  const current = details && asset ? { ...asset, name: details.name, description: details.description } : asset;
  const [fileDialog, setFileDialog] = useState<{ id: string; mode: 'details' | 'alt' }>();
  const closeFileDialog = () => setFileDialog(undefined);
  const image = state.preview?.kind === 'image';
  const actions = current && <>
    <a className="sp-button sp-button--ghost sp-button--sm" href={assetUrl(current.id, 'download')} aria-label="Download original" title="Download original">{image ? <CloudArrowDown size={18}/> : <DownloadSimple size={18}/>}</a>
    {image && details && (details.can_edit || details.description) && <Button size="sm" variant="ghost"
      aria-label={details.description ? 'Image description' : 'Add alt text'} title={details.description ? 'Image description' : 'Add alt text'}
      onClick={() => setFileDialog({ id: current.id, mode: 'alt' })}>{details.description ? 'ALT' : '+ ALT'}</Button>}
    {details?.thread_id && <a className="sp-button sp-button--ghost sp-button--sm" title="Show thread" aria-label="Show thread" href={conversationPath(details.channel_id, details.thread_id) ?? undefined}>{image ? <SidebarSimple size={18}/> : <ChatCircle size={18}/>}</a>}
    {!standalone && <a className="sp-button sp-button--ghost sp-button--sm" title="Open in new window" aria-label="Open in new window" href={`/file/${encodeURIComponent(current.id)}`} target="_blank" rel="noopener noreferrer"><ArrowSquareOut size={18}/></a>}
    {details?.can_edit && (image
      ? <Menu className="asset-image-menu" label="More actions" trigger={<DotsThree size={20} weight="bold"/>}
          items={[{ label: 'Edit file details', icon: <PencilSimple size={16}/>, onSelect: () => setFileDialog({ id: current.id, mode: 'details' }) }]} />
      : <IconButton label="Edit file details" onClick={() => setFileDialog({ id: current.id, mode: 'details' })}><PencilSimple size={18}/></IconButton>)}
  </>;
  function navigate(direction: number) { const next = assets[index + direction]; if (next) leave(() => onSelect(next.id)); }
  function keyboard(event: globalThis.KeyboardEvent) {
    if (event.defaultPrevented || event.key === 'Escape' || (event.target as HTMLElement).closest('dialog') !== viewer.current?.closest('dialog')) return;
    const target = event.target as HTMLElement;
    const control = target.closest('input,textarea,select,audio,video,[contenteditable=true],[data-pdf-controls],[role=region]');
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (control && target.closest('dialog')?.contains(control))) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); navigate(event.key === 'ArrowLeft' ? -1 : 1); }
  }
  useEffect(() => {
    const dialog = viewer.current?.closest('dialog');
    if (!dialog) return;
    dialog.addEventListener('keydown', keyboard);
    return () => dialog.removeEventListener('keydown', keyboard);
  });
  return current ? <><Dialog open onClose={onClose} onBeforeClose={() => {
      if (!exit.current) return true;
      exit.current(onClose);
      return false;
    }} title={current.name} subtitle={details && `Shared by ${details.uploader} · ${sharedAt.format(new Date(details.shared_at))}`}>
      <div className={assets.length === 1 ? 'asset-viewer asset-viewer--single' : 'asset-viewer'} ref={viewer} data-image={image || undefined}>
        {channelLabel && <span className="asset-office-channel">{channelLabel}</span>}
        <div className="asset-viewer-toolbar">
          <div className="asset-file-navigation"><IconButton label="Previous file" disabled={index <= 0} onClick={() => navigate(-1)}><ArrowLeft size={20} /></IconButton><span>{index + 1} of {assets.length}</span><IconButton label="Next file" disabled={index >= assets.length - 1} onClick={() => navigate(1)}><ArrowRight size={20} /></IconButton></div>
          {!image && actions}
        </div>
        <div key={current.id} className="asset-viewer-content"><ViewerContent initialPage={initialPage} state={state} actions={actions} asset={current} close={onClose} exit={exit} onAccessLost={onAccessLost} /></div>
        {assets.length > 1 && <div className="asset-filmstrip" role="group" aria-label="Attached files">{assets.map((asset, position) => <button type="button" key={asset.id} aria-label={`View ${asset.id === current.id ? current.name : asset.name}`} aria-pressed={position === index} onClick={() => leave(() => onSelect(asset.id))}><FilmstripPreview asset={asset} preview={previews[asset.id]} /><span>{asset.id === current.id ? current.name : asset.name}</span></button>)}</div>}
      </div>
    </Dialog>
    {details && fileDialog?.id === selectedId && (details.can_edit
      ? <FileDetailsForm key={selectedId} details={details} altOnly={fileDialog.mode === 'alt'} onSaved={state.saved} onClose={closeFileDialog} />
      : fileDialog.mode === 'alt' && <Dialog open title="Image description" onClose={closeFileDialog}><p>{details.description}</p></Dialog>)}
  </> : null;
}
