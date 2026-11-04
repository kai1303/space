import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AssetAttachment, AssetPreview } from '@space/contracts';
import { Button, Dialog, IconButton } from '@space/ui/primitives';
import { CodeBlock } from '@space/ui/rich-text';
import { ArrowLeft, ArrowRight, DownloadSimple, File, FileCode, FilePdf, MagnifyingGlassMinus, MagnifyingGlassPlus, MusicNote, VideoCamera } from '@phosphor-icons/react';
import './asset-attachments.css';

const PdfPreview = lazy(() => import('./PdfPreview.js').then(module => ({ default: module.PdfPreview })));
const assetUrl = (id: string, action: string) => `/v1/assets/${encodeURIComponent(id)}/${action}`;
function usePreview(id: string, onAccessLost?: (status: number) => void) {
  const accessLost = useRef(onAccessLost);
  useEffect(() => { accessLost.current = onAccessLost; }, [onAccessLost]);
  const [state, setState] = useState<{ id: string; preview?: AssetPreview; failed?: boolean }>({ id });
  useEffect(() => {
    const controller = new AbortController();
    setState({ id });
    void fetch(assetUrl(id, 'preview'), { credentials: 'same-origin', signal: controller.signal }).then(async response => {
      if (controller.signal.aborted) return;
      if (response.status === 401) window.dispatchEvent(new Event('space:session-expired'));
      if ([401, 403, 404].includes(response.status)) accessLost.current?.(response.status);
      if (!response.ok) throw new Error('Preview unavailable');
      const preview = await response.json() as AssetPreview;
      if (!preview || !['image', 'pdf', 'audio', 'video', 'text', 'unsupported'].includes(preview.kind)) throw new Error('Invalid preview');
      if (!controller.signal.aborted) setState({ id, preview });
    }).catch(() => { if (!controller.signal.aborted) setState({ id, failed: true }); });
    return () => controller.abort();
  }, [id]);
  return { ...(state.id === id ? state : { id }), fail: () => setState({ id, failed: true }) };
}
function FileSymbol({ kind }: { kind?: AssetPreview['kind'] | 'file' }) {
  const Icon = kind === 'pdf' ? FilePdf : kind === 'text' ? FileCode : kind === 'audio' ? MusicNote : kind === 'video' ? VideoCamera : File;
  return <Icon size={28} aria-hidden="true" />;
}
function NativeMedia({ asset, kind, onError }: { asset: AssetAttachment; kind: 'audio' | 'video'; onError: () => void }) {
  const props = { controls: true, preload: 'metadata', src: assetUrl(asset.id, 'content'), onError, 'aria-label': asset.name };
  return kind === 'audio' ? <audio {...props} /> : <video {...props} playsInline />;
}
function AttachmentCard({ asset, onOpen, onPreview }: { asset: AssetAttachment; onOpen: (element: HTMLElement) => void; onPreview: (id: string, preview?: AssetPreview) => void }) {
  const { preview, failed, fail } = usePreview(asset.id);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  useEffect(() => {
    onPreview(asset.id, preview);
    return () => onPreview(asset.id);
  }, [asset.id, preview, onPreview]);
  return <div className={`asset-card ${preview?.kind === 'image' ? 'asset-card--image' : ''}`} style={preview?.kind === 'image' ? { width: Math.max(160, Math.min(360, preview.width, 320 * preview.width / preview.height)) } : undefined}>
    {preview?.kind === 'image' && <button type="button" className="asset-image-button" aria-label={`Preview ${asset.name}`} onClick={event => onOpen(event.currentTarget)}>
      <img src={assetUrl(asset.id, 'thumbnail')} alt={asset.name} width={preview.width} height={preview.height} loading="lazy" onError={fail} />
    </button>}
    {(preview?.kind === 'video' || preview?.kind === 'audio') && <NativeMedia asset={asset} kind={preview.kind} onError={fail} />}
    <div className="asset-card-info">
      {preview?.kind !== 'image' && <span className={`asset-file-icon asset-file-icon--${preview?.kind ?? 'file'}`}><FileSymbol kind={preview?.kind} /></span>}
      <button type="button" className="asset-filename" aria-label={`Open ${asset.name}`} onClick={event => onOpen(event.currentTarget)}><span>{asset.name}</span><small>{Math.max(1, Math.round(asset.size / 1024))} KB{preview?.kind === 'pdf' ? ' · PDF' : ''}</small></button>
      <a className="asset-card-download sp-button sp-button--ghost sp-button--sm sp-icon-button" aria-label={`Download ${asset.name}`} title={`Download ${asset.name}`} href={assetUrl(asset.id, 'download')}><DownloadSimple size={18} aria-hidden="true" /></a>
      {preview?.kind !== 'image' && <IconButton label={`Preview ${asset.name}`} size="sm" onClick={event => onOpen(event.currentTarget)}><span aria-hidden="true">↗</span></IconButton>}
    </div>
    {preview?.kind === 'pdf' && preview.thumbnail !== false && !thumbnailFailed && <button type="button" className="asset-pdf-thumbnail" aria-label={`Preview first page of ${asset.name}`} onClick={event => onOpen(event.currentTarget)}>
      <img src={assetUrl(asset.id, 'thumbnail')} alt={`First page of ${asset.name}`} loading="lazy" width={360} height={240} onError={() => setThumbnailFailed(true)} />
    </button>}
    {preview?.kind === 'text' && <div className="asset-snippet"><span className="asset-preview-label">Text preview</span><CodeBlock code={preview.text.slice(0, 1800).split('\n').slice(0, 8).join('\n')} language={preview.language} /></div>}
    {(failed || preview?.kind === 'unsupported') && <p className="asset-unavailable">Preview unavailable</p>}
  </div>;
}
function ImagePreview({ asset, preview, onError }: { asset: AssetAttachment; preview: Extract<AssetPreview, { kind: 'image' }>; onError: () => void }) {
  const [zoom, setZoom] = useState(1);
  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const resize = () => setFit(Math.min(1, (node.clientWidth - 32) / preview.width, (node.clientHeight - 32) / preview.height));
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [preview.width, preview.height]);
  return <>
    <div className="asset-image-stage" ref={stage}>
      <img src={assetUrl(asset.id, 'content')} alt={asset.name} onError={onError} style={{ width: Math.max(1, preview.width * Math.max(0.01, fit) * zoom), height: Math.max(1, preview.height * Math.max(0.01, fit) * zoom) }} />
    </div>
    <div className="asset-image-tools" role="group" aria-label="Image zoom">
      <IconButton label="Zoom out" disabled={zoom <= 0.25} onClick={() => setZoom(value => Math.max(0.25, value - 0.25))}><MagnifyingGlassMinus size={20} /></IconButton>
      <Button variant="ghost" onClick={() => setZoom(1)} aria-label="Fit image">{Math.round(zoom * 100)}% · Fit</Button>
      <IconButton label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + 0.25))}><MagnifyingGlassPlus size={20} /></IconButton>
    </div>
  </>;
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
  return <div className="asset-text-preview"><CodeBlock code={code} language={preview.language} />
    {(shortened || preview.truncated) && <p role="status">{shortened ? 'Preview shortened to 20,000 characters, 32 KiB, or 1,000 lines.' : 'Showing the first 256 KiB.'} Download to read the complete file.</p>}
  </div>;
}
function ViewerContent({ asset, onAccessLost }: { asset: AssetAttachment; onAccessLost?: (status: number) => void }) {
  const { preview, failed, fail } = usePreview(asset.id, onAccessLost);
  if (failed || preview?.kind === 'unsupported') return <div className="asset-viewer-fallback"><File size={56} /><p role="status">Preview unavailable</p><p>Download the original to open this file.</p></div>;
  if (!preview) return <p className="asset-viewer-loading" role="status">Loading preview…</p>;
  const kindLabel = { image: 'Image', pdf: 'PDF', text: 'Text', audio: 'Audio', video: 'Video' }[preview.kind];
  let content;
  if (preview.kind === 'image') content = <ImagePreview asset={asset} preview={preview} onError={fail} />;
  else if (preview.kind === 'pdf') content = <Suspense fallback={<p role="status">Loading PDF viewer…</p>}><PdfPreview assetId={asset.id} size={asset.size} /></Suspense>;
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
  return <>
    <div className="chat-attachments asset-attachments">{assets.map(asset => <AttachmentCard key={asset.id} asset={asset} onPreview={rememberPreview} onOpen={element => { opener.current = element; setSelected(asset.id); }} />)}</div>
    {selected && <AssetViewer assets={assets} selectedId={selected} onSelect={setSelected} onClose={close} previews={previews} />}
  </>;
}
export function AssetViewer({ assets, selectedId, onSelect, onClose, onAccessLost, previews = {} }: {
  assets: AssetAttachment[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  previews?: Record<string, { kind: AssetPreview['kind'] | 'file' } | undefined>;
  onAccessLost?: (status: number) => void;
}) {
  const viewer = useRef<HTMLDivElement>(null);
  const index = assets.findIndex(asset => asset.id === selectedId);
  const current = assets[index];
  function navigate(direction: number) { const next = assets[index + direction]; if (next) onSelect(next.id); }
  function keyboard(event: globalThis.KeyboardEvent) {
    if (event.key === 'Escape') return;
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
  return current ? <Dialog open onClose={onClose} title={current.name}>
      <div className="asset-viewer" ref={viewer}>
        <div className="asset-viewer-toolbar">
          <div className="asset-file-navigation"><IconButton label="Previous file" disabled={index <= 0} onClick={() => navigate(-1)}><ArrowLeft size={20} /></IconButton><span>{index + 1} of {assets.length}</span><IconButton label="Next file" disabled={index >= assets.length - 1} onClick={() => navigate(1)}><ArrowRight size={20} /></IconButton></div>
          <a className="sp-button sp-button--secondary sp-button--sm" href={assetUrl(current.id, 'download')}><DownloadSimple size={16} />Download original</a>
        </div>
        <div className="asset-viewer-content"><ViewerContent key={current.id} asset={current} onAccessLost={onAccessLost} /></div>
        {assets.length > 1 && <div className="asset-filmstrip" role="group" aria-label="Attached files">{assets.map((asset, position) => <button type="button" key={asset.id} aria-label={`View ${asset.name}`} aria-pressed={position === index} onClick={() => onSelect(asset.id)}><FilmstripPreview asset={asset} preview={previews[asset.id]} /><span>{asset.name}</span></button>)}</div>}
      </div>
    </Dialog> : null;
}
