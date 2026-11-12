import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { ArrowClockwise, Minus, Plus } from '@phosphor-icons/react';
import { IconButton } from './primitives.js';

type Point = { x: number; y: number };
type View = Point & { scale: number | null };
const centered: View = { x: 0, y: 0, scale: null };
const stops = [0.5, 1, 1.5, 2];
const maxScale = 2;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const center = { x: 0, y: 0 };

export function ImageStage({ src, alt, onError, actions, onClose }: {
  src: string; alt: string; onError?: () => void; actions?: ReactNode; onClose?: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: Point; last: Point; box: boolean; moved: boolean; id: number } | null>(null);
  const [selection, setSelection] = useState<{ start: Point; end: Point } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [turn, rotate] = useState(0);
  const [animate, setAnimate] = useState(false);
  const [view, setView] = useState<View>(centered);
  const width = turn % 2 ? size.height : size.width;
  const height = turn % 2 ? size.width : size.height;
  const fit = width && height && viewport.width && viewport.height
    ? Math.min(1, viewport.width / width, viewport.height / height) : 1;
  const scale = Math.max(fit, view.scale ?? fit);
  function bounded(next: View): View {
    const extra = Math.max(0, (next.scale ?? fit) - fit) / 2;
    return {
      scale: next.scale, x: clamp(next.x, -width * extra, width * extra),
      y: clamp(next.y, -height * extra, height * extra),
    };
  }
  const offset = bounded(view);
  function pointAt(clientX: number, clientY: number): Point {
    const rect = stage.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }
  function zoomTo(next: number, from = center, to = from, smooth = true) {
    setAnimate(smooth);
    const nextScale = clamp(next, fit, maxScale);
    setView(previous => {
      if (nextScale === fit) return centered;
      const ratio = nextScale / Math.max(fit, previous.scale ?? fit);
      const previousOffset = bounded(previous);
      return bounded({ scale: nextScale, x: to.x + (previousOffset.x - from.x) * ratio,
        y: to.y + (previousOffset.y - from.y) * ratio });
    });
  }
  function step(direction: 1 | -1, point = center) {
    const next = direction > 0 ? stops.find(s => s > scale) : stops.findLast(s => s < scale);
    zoomTo(next ?? (direction > 0 ? maxScale : fit), point);
  }
  function pan(x: number, y: number, smooth = false) {
    setAnimate(smooth);
    setView(previous => {
      const start = bounded(previous);
      return bounded({ ...start, x: start.x + x, y: start.y + y });
    });
  }
  const wheel = useEffectEvent((e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.deltaMode !== 0) {
      const point = pointAt(e.clientX, e.clientY);
      zoomTo(scale - e.deltaY * 0.01, point, point, false);
    }
    else if (scale > fit) pan(-0.6 * e.deltaX, -0.6 * e.deltaY);
  });
  const keyDown = useEffectEvent((e: KeyboardEvent) => {
    const target = e.target;
    if (!(target instanceof HTMLElement) || target.closest('dialog') !== stage.current?.closest('dialog') ||
        target.closest('input,textarea,select,[contenteditable=true],[role=menu]') || e.defaultPrevented ||
        e.ctrlKey || e.metaKey || e.altKey) return;
    const distance = e.shiftKey ? 300 : 50;
    switch (e.key) {
      case '=': case '+': step(1); break;
      case '-': step(-1); break;
      case '0': zoomTo(fit); break;
      case 'r': case 'R': turnClockwise(); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
        if (scale <= fit) return;
        pan(e.key === 'ArrowLeft' ? distance : e.key === 'ArrowRight' ? -distance : 0,
          e.key === 'ArrowUp' ? distance : e.key === 'ArrowDown' ? -distance : 0, true);
        break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  useEffect(() => {
    const node = stage.current!;
    const measure = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(node);
    const dialog = node.closest('dialog');
    node.addEventListener('wheel', wheel, { passive: false });
    dialog?.addEventListener('keydown', keyDown, true);
    return () => {
      observer?.disconnect();
      node.removeEventListener('wheel', wheel);
      dialog?.removeEventListener('keydown', keyDown, true);
    };
  }, []);
  function clearDrag() { drag.current = null; setSelection(null); }
  function turnClockwise() { setAnimate(true); rotate(t => t + 1); }
  const percent = Math.round(scale * 100) + '%';
  return <div className="sp-image-view">
    <div className="sp-image-stage" ref={stage} aria-label="Image preview" tabIndex={0}
      data-zoomed={scale > fit || undefined} data-animate={animate || undefined}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}
      onPointerDown={e => {
        if (e.button || !e.isPrimary || !(e.target instanceof HTMLImageElement)) return;
        const start = pointAt(e.clientX, e.clientY);
        const mac = /Mac/.test(navigator.platform);
        if (mac && e.ctrlKey) return;
        drag.current = { start, last: start, box: mac ? e.metaKey : e.ctrlKey, moved: false, id: e.pointerId };
        e.target.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const gesture = drag.current;
        if (!gesture || e.pointerId !== gesture.id) return;
        const end = pointAt(e.clientX, e.clientY);
        if (Math.hypot(end.x - gesture.start.x, end.y - gesture.start.y) > 4) gesture.moved = true;
        if (!gesture.moved) return;
        if (gesture.box) setSelection({ start: gesture.start, end });
        else if (scale > fit) pan(end.x - gesture.last.x, end.y - gesture.last.y);
        gesture.last = end;
      }}
      onPointerUp={e => {
        const gesture = drag.current;
        if (!gesture || e.pointerId !== gesture.id) return;
        const end = pointAt(e.clientX, e.clientY);
        if (!gesture.moved) {
          if (e.altKey) step(-1, end);
          else if (scale === fit) zoomTo(fit < 0.9 ? 1 : 2, end);
          else zoomTo(fit);
        } else if (gesture.box) {
          const w = Math.abs(end.x - gesture.start.x), h = Math.abs(end.y - gesture.start.y);
          const middle = { x: (gesture.start.x + end.x) / 2, y: (gesture.start.y + end.y) / 2 };
          zoomTo(scale * Math.min(viewport.width / w, viewport.height / h), middle, center);
        }
        clearDrag();
      }}
      onLostPointerCapture={clearDrag} onPointerCancel={clearDrag}>
      <img src={src} alt={alt} draggable={false} onError={onError}
        onLoad={e => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        style={{ width: size.width || undefined,
          transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) rotate(${turn * 90}deg) scale(${scale})` }} />
      {selection && <div className="sp-image-selection" style={{
        left: viewport.width / 2 + Math.min(selection.start.x, selection.end.x),
        top: viewport.height / 2 + Math.min(selection.start.y, selection.end.y),
        width: Math.abs(selection.start.x - selection.end.x), height: Math.abs(selection.start.y - selection.end.y),
      }} />}
    </div>
    <div className="sp-image-controls" role="toolbar" aria-label="Media controls">
      <IconButton label="Rotate" onClick={turnClockwise}><ArrowClockwise size={18}/></IconButton>
      <div className="sp-image-zoom" role="group" aria-label="Image zoom">
        <IconButton label="Zoom out" disabled={scale <= fit} onClick={() => step(-1)}><Minus size={16}/></IconButton>
        <input aria-label="Zoom" aria-valuetext={percent} title={percent} type="range" min="0" max="1" step="0.01"
          value={(scale - fit) / (maxScale - fit)} onChange={e => zoomTo(fit + e.currentTarget.valueAsNumber * (maxScale - fit))} />
        <IconButton label="Zoom in" disabled={scale >= maxScale} onClick={() => step(1)}><Plus size={16}/></IconButton>
      </div>
      {actions && <div className="sp-image-actions">{actions}</div>}
    </div>
  </div>;
}
