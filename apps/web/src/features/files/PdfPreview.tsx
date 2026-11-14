import { sessionFetch } from '../../shared/api/session-fetch.js';
import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, LoadingStatus } from '@space/ui/primitives';
import { ArrowLeft, ArrowRight, MagnifyingGlassMinus, MagnifyingGlassPlus } from '@phosphor-icons/react';
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
export function PdfPreview({ assetId, size, initialPage = 1 }: { assetId: string; size: number; initialPage?: number }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage), [zoom, setZoom] = useState(1), [failed, setFailed] = useState(false), [rendering, setRendering] = useState(true);
  const pages = useRef<HTMLDivElement>(null);
  const [painted, setPainted] = useState<{pdf: PDFDocumentProxy; page: number}>();
  const stopLoading = useRef<(() => void) | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let loading: ReturnType<typeof getDocument> | undefined;
    const stop = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      void loading?.destroy().catch(() => {});
    };
    const fail = () => {
      if (controller.signal.aborted) return;
      setFailed(true);
      stop();
    };
    stopLoading.current = stop;
    setPdf(null); setPainted(undefined); setFailed(false); setPage(initialPage); setZoom(1); setRendering(true);
    const transport = new PDFDataRangeTransport(size, new Uint8Array(0), true);
    transport.abort = stop;
    transport.requestDataRange = (begin, end) => {
      if (controller.signal.aborted) return;
      const limit = Math.min(end, size);
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || limit <= begin) { fail(); return; }
      void sessionFetch(`/v1/assets/${encodeURIComponent(assetId)}/content`, {
        credentials: 'same-origin', signal: controller.signal, headers: { Range: `bytes=${begin}-${limit - 1}` },
      }).then(async response => {
        if (controller.signal.aborted) return;
        if (response.status === 401) window.dispatchEvent(new Event('space:session-expired'));
        if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${begin}-${limit - 1}/${size}` ||
          response.headers.get('Content-Length') !== String(limit - begin) || !/^application\/pdf(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
          throw new Error('Invalid PDF range response');
        }
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength !== limit - begin) throw new Error('Incomplete PDF range');
        if (!controller.signal.aborted) transport.onDataRange(begin, data);
      }).catch(fail);
    };
    try {
      // PDF.js 6 removed eval support; retain the flag for compatible older builds.
      const options = { range: transport, length: size, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65_536, isEvalSupported: false, stopAtErrors: true };
      loading = getDocument(options);
      void loading.promise.then(document => { if (!controller.signal.aborted) setPdf(document); }).catch(fail);
    } catch { fail(); }
    return stop;
  }, [assetId, size, initialPage]);
  useEffect(() => {
    if (!pdf || page > pdf.numPages) return;
    let active = true;
    let task: RenderTask | undefined;
    let cleanup: (() => void) | undefined;
    setRendering(true);
    void pdf.getPage(page).then(async documentPage => {
      if (!active || !pages.current) return;
      cleanup = () => documentPage.cleanup();
      const original = documentPage.getViewport({ scale: 1 });
      const fit = Math.min(1.25, Math.max(240, (pages.current.parentElement?.clientWidth ?? 800) - 32) / original.width);
      const desired = fit * zoom * Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.min(desired, 8192 / original.width, 8192 / original.height, Math.sqrt(16_777_216 / (original.width * original.height)));
      const viewport = documentPage.getViewport({ scale });
      const element = document.createElement('canvas');
      element.setAttribute('aria-label', `PDF page ${page}`);
      element.width = Math.max(1, Math.floor(viewport.width)); element.height = Math.max(1, Math.floor(viewport.height));
      element.style.width = `${original.width * fit * zoom}px`;
      element.style.height = `${original.height * fit * zoom}px`;
      const context = element.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      task = documentPage.render({ canvas: element, canvasContext: context, viewport });
      await task.promise;
      if (active && pages.current) {
        pages.current.replaceChildren(element);
        setPainted({pdf, page});
        setRendering(false);
      }
    }).catch(() => { if (active) { stopLoading.current?.(); setFailed(true); setRendering(false); } });
    return () => { active = false; task?.cancel(); cleanup?.(); };
  }, [pdf, page, zoom]);
  if (failed) return <p role="alert" className="asset-viewer-fallback">PDF preview unavailable. Download the original to open it.</p>;
  if (pdf && page > pdf.numPages) return <p role="alert">Page {page} is unavailable. This PDF has {pdf.numPages} pages.</p>;
  return <div className="asset-pdf-preview">
    <div className="asset-pdf-tools" data-pdf-controls role="group" aria-label="PDF controls">
      <IconButton label="Previous page" disabled={!pdf || page <= 1} onClick={() => setPage(value => value - 1)}><ArrowLeft size={18} /></IconButton>
      {pdf ? <span>Page {page} of {pdf.numPages}</span> : null}
      <IconButton label="Next page" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(value => value + 1)}><ArrowRight size={18} /></IconButton>
      <IconButton label="Zoom out" disabled={zoom <= 0.25} onClick={() => setZoom(value => Math.max(0.25, value - 0.25))}><MagnifyingGlassMinus size={18} /></IconButton>
      <Button variant="ghost" size="sm" onClick={() => setZoom(1)} aria-label="Fit PDF">{Math.round(zoom * 100)}%</Button>
      <IconButton label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + 0.25))}><MagnifyingGlassPlus size={18} /></IconButton>
    </div>
    <div className="asset-pdf-pages" aria-busy={!pdf || rendering}>
      {!pdf ? <LoadingStatus>Loading PDF…</LoadingStatus> : rendering && <LoadingStatus>Rendering page {page}…</LoadingStatus>}
      <div ref={pages} hidden={!pdf || painted?.pdf !== pdf || painted.page !== page}/>
    </div>
  </div>;
}
