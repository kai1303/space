import { useEffect, useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, ArrowRight, DotsSixVertical, File, FileCode, FilePdf, ImageSquare, MusicNote, VideoCamera, X } from '@phosphor-icons/react';
import { MAX_ASSET_DESCRIPTION_LENGTH } from '@space/contracts';
import { Button, Dialog, IconButton } from '../primitives/primitives.js';
import { motionTransition } from '../motion/motion.js';
import type { Attachment } from '../rich-text/rich-text.js';

function DraftCard({ file, disabled, onRemove, onRetry, onDescribe }: {
  file: Attachment; disabled: boolean; onRemove: () => void; onRetry?: () => void; onDescribe: (description: string) => void;
}) {
  const isImage = file.type.startsWith('image/');
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState('');
  const descriptionId = useId();
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setFailed(false);
    if (!isImage || !file.file) { setSource(undefined); return; }
    const url = URL.createObjectURL(file.file);
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [file.file, isImage]);
  const Icon = isImage ? ImageSquare : file.type === 'application/pdf' ? FilePdf : file.type.startsWith('text/') ? FileCode : file.type.startsWith('audio/') ? MusicNote : file.type.startsWith('video/') ? VideoCamera : File;
  function open(element: HTMLElement) {
    opener.current = element; setDescription(file.description ?? ''); setEditing(true);
  }
  function close() { setEditing(false); queueMicrotask(() => opener.current?.isConnected && opener.current.focus()); }
  return <>
    <div className={`sp-draft-file-content ${isImage ? 'sp-draft-file-content--image' : ''}`}>
      {isImage ? <button type="button" className="sp-draft-thumbnail" aria-label={`Preview ${file.name}`} disabled={disabled} onClick={event => open(event.currentTarget)}>
        {source && !failed ? <img src={source} alt={file.description || file.name} onError={() => setFailed(true)} /> : <Icon size={32} aria-hidden="true" />}
      </button> : <span className="sp-draft-file-icon"><Icon size={32} aria-hidden="true" /></span>}
      <div className="sp-draft-file-info"><strong title={file.name}>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024))} KB · {file.status === 'uploading' ? 'Uploading…' : file.status === 'error' ? 'Upload failed' : 'Ready'}</small></div>
      <IconButton label={`Remove ${file.name}`} className="sp-draft-remove" size="sm" disabled={disabled} onClick={onRemove}><X size={16} /></IconButton>
    </div>
    {file.status === 'uploading' && <progress aria-label={`Uploading ${file.name}`} value={file.progress ?? 0} max={100} />}
    {file.status === 'error' && <div className="sp-draft-upload-error"><small role="alert">{file.error || 'Upload failed'}</small><Button size="sm" disabled={disabled} aria-label={`Retry upload ${file.name}`} onClick={onRetry}>Retry</Button></div>}
    {isImage && <Button className="sp-draft-description-trigger" variant="ghost" size="sm" disabled={disabled} aria-label={`${file.description ? 'Edit' : 'Add'} description for ${file.name}`} onClick={event => open(event.currentTarget)}>{file.description ? 'Edit description' : 'Add description'}</Button>}
    {editing && <Dialog open title={file.name} onClose={close}>
      <div className="sp-draft-image-details">
        {source && !failed && <img src={source} alt={file.description || file.name} onError={() => setFailed(true)} />}
        <label htmlFor={descriptionId}>Image description</label>
        <p id={`${descriptionId}-hint`}>Describe what’s in the image for people using screen readers.</p>
        <textarea id={descriptionId} aria-describedby={`${descriptionId}-hint`} maxLength={MAX_ASSET_DESCRIPTION_LENGTH} value={description} disabled={disabled} onChange={event => setDescription(event.target.value)} rows={3} />
        <small>{description.length} / {MAX_ASSET_DESCRIPTION_LENGTH}</small>
        <div className="sp-draft-dialog-actions"><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={disabled} onClick={() => { onDescribe(description.trim()); close(); }}>Save description</Button></div>
      </div>
    </Dialog>}
  </>;
}

export function AttachmentDrafts({ files, onChange, disabled = false, onRetry }: {
  files: Attachment[]; onChange: (files: Attachment[]) => void; disabled?: boolean; onRetry?: (id: string) => void;
}) {
  const reduced = useReducedMotion();
  const list = useRef<HTMLOListElement>(null);
  const dragging = useRef<{ id: string; x: number; y: number; target?: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  function move(id: string, destination: number) {
    const index = files.findIndex(file => file.id === id);
    if (disabled || index < 0 || destination < 0 || destination >= files.length || index === destination) return;
    const next = [...files];
    const [file] = next.splice(index, 1);
    next.splice(destination, 0, file!);
    onChange(next);
    setAnnouncement(`${file!.name} moved to position ${destination + 1} of ${files.length}`);
  }
  return <>
    <ol className="sp-attachment-drafts" aria-label="Attachments" ref={list}>
      {files.map((file, index) => <motion.li layout={!reduced} transition={motionTransition(reduced)} key={file.draftId ?? file.id} aria-label={file.name}
        data-attachment-id={file.id} className={dropTarget === file.id ? 'sp-draft-drop-target' : undefined}>
        <DraftCard file={file} disabled={disabled} onRemove={() => onChange(files.filter(item => item.id !== file.id))} onRetry={() => onRetry?.(file.id)} onDescribe={description => onChange(files.map(item => item.id === file.id ? { ...item, description } : item))} />
        {files.length > 1 && <div className="sp-draft-reorder">
          <button type="button" className="sp-draft-drag" aria-label={`Drag ${file.name} to reorder`} title="Drag to reorder, or use the move buttons" disabled={disabled}
            onPointerDown={event => {
              if (disabled || event.button !== 0) return;
              dragging.current = { id: file.id, x: event.clientX, y: event.clientY };
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={event => {
              const drag = dragging.current;
              if (!drag || disabled || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
              const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-attachment-id]');
              drag.target = target && list.current?.contains(target) ? target.dataset.attachmentId : undefined;
              setDropTarget(drag.target);
            }}
            onPointerUp={event => {
              const drag = dragging.current;
              if (drag?.target) move(drag.id, files.findIndex(item => item.id === drag.target));
              dragging.current = null; setDropTarget(undefined);
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => { dragging.current = null; setDropTarget(undefined); }}
            onPointerCancel={() => { dragging.current = null; setDropTarget(undefined); }}
            onKeyDown={event => { if (event.key === 'Escape') { dragging.current = null; setDropTarget(undefined); } }}><DotsSixVertical size={16} aria-hidden="true" /></button>
          <span>{index + 1} of {files.length}</span>
          <IconButton size="sm" label={`Move ${file.name} earlier`} disabled={disabled || index === 0} onClick={() => move(file.id, index - 1)}><ArrowLeft size={14} /></IconButton>
          <IconButton size="sm" label={`Move ${file.name} later`} disabled={disabled || index === files.length - 1} onClick={() => move(file.id, index + 1)}><ArrowRight size={14} /></IconButton>
        </div>}
      </motion.li>)}
    </ol>
    <span className="sp-sr-only" role="status" aria-live="polite">{announcement}</span>
  </>;
}
