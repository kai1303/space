import { readComposerDrafts, persistComposerDrafts } from './composer-drafts.js';
import { DraftSync, destination, emptyDraft } from './draft-sync.js';
import { useEffect, useRef, useState } from 'react';
import { type Attachment, type RichDocument } from '@space/ui/rich-text';
import { pendingToast, toast } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import { type MessageAttempt } from './message-sender.js';
import { uploadAsset, type AssetConfig } from '../files/assets.js';
import { errorText } from '../../shared/api/error-text.js';

export type UploadDrafts = {
  enabled: boolean;
  lockedDrafts?: Record<string, boolean>;
  attempt: (key: string) => MessageAttempt;
  sent: (key: string, document: RichDocument, files: Attachment[]) => void;
  drafts: Record<string, Attachment[]>;
  acknowledged: Record<string, RichDocument>;
  change: (key: string, channel: string, files: Attachment[], transfer?: typeof uploadAsset) => void;
  retry: (key: string, channel: string, id: string, transfer?: typeof uploadAsset) => void;
};
export function useAttachmentUploads(viewer: string) {
  const [legacy] = useState(() => readComposerDrafts(viewer));
  const draftState = useRef<Record<string, RichDocument>>({ ...legacy });
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, Attachment[]>>({});
  const [lockedDrafts, setLockedDrafts] = useState<Record<string, boolean>>({});
  const [acknowledgedDrafts, setAcknowledgedDrafts] = useState<Record<string, RichDocument>>({});
  const attachmentState = useRef(attachmentDrafts);
  const [sync] = useState(() => new DraftSync(viewer, {
    notify: message => toast.info(message),
    apply(key, content, locked) {
      draftState.current = { ...draftState.current, [key]: content.document };
      const pending = (attachmentState.current[key] ?? []).filter(file => file.status === 'uploading' || file.status === 'error');
      attachmentState.current = { ...attachmentState.current, [key]: [...content.attachments, ...pending] };
      setAttachmentDrafts(attachmentState.current);
      setLockedDrafts(old => old[key] === locked ? old : { ...old, [key]: locked });
    },
    journaled(key) {
      // Remove only the migrated legacy entry after the durable edit is in place.
      const stored = readComposerDrafts(viewer);
      if (key in stored) { delete stored[key]; persistComposerDrafts(viewer, stored); }
    },
  }));
  useEffect(() => sync.start(legacy), [sync, legacy]);

  function saveDraft(key: string, document: RichDocument) {
    draftState.current[key] = document;
    if (destination(key)) sync.edit(key, { document, attachments: attachmentState.current[key] ?? [] });
    else if (!key.startsWith('encrypted:')) persistComposerDrafts(viewer, { ...readComposerDrafts(viewer), [key]: document });
  }
  const uploadJobs = useRef(new Map<string, { key: string; controller: AbortController }>());
  const messageAttempts = useRef(new Map<string, MessageAttempt>());
  const [assetsEnabled, setAssetsEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void request<AssetConfig>('/assets/config').then(config => { if (active) setAssetsEnabled(config.enabled === true); }).catch(() => {});
    return () => { active = false; for (const job of uploadJobs.current.values()) job.controller.abort(); uploadJobs.current.clear(); messageAttempts.current.clear(); };
  }, []);
  function updateAttachments(key: string, change: (files: Attachment[]) => Attachment[]) {
    const previous = attachmentState.current[key] ?? [];
    const next = change(previous);
    attachmentState.current = { ...attachmentState.current, [key]: next };
    setAttachmentDrafts(attachmentState.current);
    const ready = (files: Attachment[]) => files.filter(file => file.status === 'ready' || !file.status);
    const before = ready(previous), after = ready(next);
    if (before.length !== after.length || before.some((file, i) => file !== after[i])) {
      sync.edit(key, { document: draftState.current[key] ?? emptyDraft.document, attachments: after });
    }
  }
  function startUpload(key: string, channel: string, attachment: Attachment, transfer = uploadAsset) {
    if (!attachment.file || uploadJobs.current.has(attachment.id)) return;
    const job = { key, controller: new AbortController() };
    uploadJobs.current.set(attachment.id, job);
    const toastId = pendingToast(`Uploading ${attachment.name}…`);
    const { signal } = job.controller;
    signal.addEventListener('abort', () => toast.dismiss(toastId), { once: true });
    const update = (change: (file: Attachment) => Attachment) => {
      if (uploadJobs.current.get(attachment.id) === job)
        updateAttachments(key, files => files.map(file => file.id === attachment.id ? change(file) : file));
    };
    update(file => ({ ...file, status: 'uploading', progress: 0, error: undefined }));
    void transfer(channel, attachment.file, progress => {
      if (signal.aborted) return;
      update(file => ({ ...file, progress }));
      toast.update(toastId, { progress: progress / 100, meta: `${progress}%` });
    }, signal)
      .then(asset => {
        if (signal.aborted) return;
        update(file => ({ ...file, ...asset, draftId: file.draftId ?? attachment.id, status: 'ready', progress: undefined, error: undefined }));
        toast.update(toastId, { type: 'success', title: `${attachment.name} is ready to send`, progress: null, meta: null });
      })
      .catch(error => {
        if (signal.aborted) return;
        const message = errorText(error);
        update(file => ({ ...file, status: 'error', error: message }));
        toast.update(toastId, { type: 'error', title: `Couldn’t upload ${attachment.name}`, description: message, progress: null, meta: null });
      })
      .finally(() => { if (uploadJobs.current.get(attachment.id) === job) uploadJobs.current.delete(attachment.id); });
  }
  function changeAttachments(key: string, channel: string, files: Attachment[], transfer = uploadAsset) {
    for (const [id, job] of uploadJobs.current) if (job.key === key && !files.some(file => file.id === id)) {
      uploadJobs.current.delete(id); job.controller.abort();
    }
    updateAttachments(key, () => files);
    for (const file of files) if (file.status === 'uploading') startUpload(key, channel, file, transfer);
  }
  const uploads: UploadDrafts = { enabled: assetsEnabled, lockedDrafts, attempt: key => {
    let state = messageAttempts.current.get(key);
    if (!state) { state = {}; messageAttempts.current.set(key, state); }
    return state;
  }, sent: (key, document, files) => {
    if (!messageAttempts.current.has(key)) return;
    setAcknowledgedDrafts(old => ({ ...old, [key]: document }));
    const sentIds = new Set(files.map(file => file.id));
    updateAttachments(key, current => current.filter(file => !sentIds.has(file.id)));
    if (JSON.stringify(draftState.current[key]) === JSON.stringify(document)) saveDraft(key, { ops: [] });
  }, acknowledged: acknowledgedDrafts, drafts: attachmentDrafts, change: changeAttachments, retry: (key, channel, id, transfer) => {
    const file = attachmentState.current[key]?.find(file => file.id === id);
    if (file?.status === 'error') startUpload(key, channel, file, transfer);
  } };
  function forgetChannelDrafts(id: string) {
    const belongs = (key: string) => key === id || key === `encrypted:${id}` || key.startsWith(`thread:${id}:`) || key.startsWith(`session:${id}:`);
    setAcknowledgedDrafts(old => Object.fromEntries(Object.entries(old).filter(([key]) => !belongs(key))));
    for (const key of messageAttempts.current.keys()) if (belongs(key)) messageAttempts.current.delete(key);
    for (const key of new Set([...Object.keys(draftState.current), ...Object.keys(attachmentState.current)])) {
      if (belongs(key) && destination(key)) sync.forget(key);
    }
    draftState.current = Object.fromEntries(Object.entries(draftState.current).filter(([key]) => !belongs(key)));
    persistComposerDrafts(viewer, Object.fromEntries(Object.entries(readComposerDrafts(viewer)).filter(([key]) => !belongs(key))));
    for (const [id, job] of uploadJobs.current) if (belongs(job.key)) { uploadJobs.current.delete(id); job.controller.abort(); }
    attachmentState.current = Object.fromEntries(Object.entries(attachmentState.current).filter(([key]) => !belongs(key)));
    setAttachmentDrafts(attachmentState.current);
  }
  function discardDraft(key: string) {
    changeAttachments(key, destination(key)?.channel ?? key, []);
    saveDraft(key, emptyDraft.document);
  }
  return { draftState, saveDraft, uploads, forgetChannelDrafts, sync, discardDraft };
}
