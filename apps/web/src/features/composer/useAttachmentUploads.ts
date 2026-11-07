import { readComposerDrafts, persistComposerDrafts } from './composer-drafts.js';
import { useEffect, useRef, useState } from 'react';
import { type Attachment, type RichDocument } from '@space/ui/rich-text';
import { request } from '../../shared/api/request.js';
import { type MessageAttempt } from './message-sender.js';
import { uploadAsset, type AssetConfig } from '../files/assets.js';
import { errorText } from '../../shared/api/error-text.js';

export type UploadDrafts = {
  enabled: boolean;
  attempt: (key: string) => MessageAttempt;
  sent: (key: string, document: RichDocument, files: Attachment[]) => void;
  drafts: Record<string, Attachment[]>;
  acknowledged: Record<string, RichDocument>;
  change: (key: string, channel: string, files: Attachment[]) => void;
  retry: (key: string, channel: string, id: string) => void;
};
export function useAttachmentUploads(viewer: string) {
  const draftState = useRef<Record<string, RichDocument>>(readComposerDrafts(viewer));
  function saveDraft(key: string, document: RichDocument) {
    draftState.current[key] = document;
    persistComposerDrafts(viewer, draftState.current);
  }
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, Attachment[]>>({});
  const [acknowledgedDrafts, setAcknowledgedDrafts] = useState<Record<string, RichDocument>>({});
  const attachmentState = useRef(attachmentDrafts);
  const uploadJobs = useRef(new Map<string, { key: string; controller: AbortController }>());
  const messageAttempts = useRef(new Map<string, MessageAttempt>());
  const [assetsEnabled, setAssetsEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void request<AssetConfig>('/assets/config').then(config => { if (active) setAssetsEnabled(config.enabled === true); }).catch(() => {});
    return () => { active = false; for (const job of uploadJobs.current.values()) job.controller.abort(); uploadJobs.current.clear(); messageAttempts.current.clear(); };
  }, []);
  function updateAttachments(key: string, change: (files: Attachment[]) => Attachment[]) {
    attachmentState.current = { ...attachmentState.current, [key]: change(attachmentState.current[key] ?? []) };
    setAttachmentDrafts(attachmentState.current);
  }
  function startUpload(key: string, channel: string, attachment: Attachment) {
    if (!attachment.file || uploadJobs.current.has(attachment.id)) return;
    const job = { key, controller: new AbortController() };
    uploadJobs.current.set(attachment.id, job);
    const update = (change: (file: Attachment) => Attachment) => {
      if (uploadJobs.current.get(attachment.id) === job)
        updateAttachments(key, files => files.map(file => file.id === attachment.id ? change(file) : file));
    };
    update(file => ({ ...file, status: 'uploading', progress: 0, error: undefined }));
    void uploadAsset(channel, attachment.file, progress => update(file => ({ ...file, progress })), job.controller.signal)
      .then(asset => update(file => ({ ...file, ...asset, draftId: file.draftId ?? attachment.id, status: 'ready', progress: undefined, error: undefined })))
      .catch(error => update(file => ({ ...file, status: 'error', error: errorText(error) })))
      .finally(() => { if (uploadJobs.current.get(attachment.id) === job) uploadJobs.current.delete(attachment.id); });
  }
  function changeAttachments(key: string, channel: string, files: Attachment[]) {
    for (const [id, job] of uploadJobs.current) if (job.key === key && !files.some(file => file.id === id)) {
      uploadJobs.current.delete(id); job.controller.abort();
    }
    updateAttachments(key, () => files);
    for (const file of files) if (file.status === 'uploading') startUpload(key, channel, file);
  }
  const uploads: UploadDrafts = { enabled: assetsEnabled, attempt: key => {
    let state = messageAttempts.current.get(key);
    if (!state) { state = {}; messageAttempts.current.set(key, state); }
    return state;
  }, sent: (key, document, files) => {
    if (!messageAttempts.current.has(key)) return;
    setAcknowledgedDrafts(old => ({ ...old, [key]: document }));
    const sentIds = new Set(files.map(file => file.id));
    updateAttachments(key, current => current.filter(file => !sentIds.has(file.id)));
    if (JSON.stringify(draftState.current[key]) === JSON.stringify(document)) saveDraft(key, { ops: [] });
  }, acknowledged: acknowledgedDrafts, drafts: attachmentDrafts, change: changeAttachments, retry: (key, channel, id) => {
    const file = attachmentState.current[key]?.find(file => file.id === id);
    if (file?.status === 'error') startUpload(key, channel, file);
  } };
  function forgetChannelDrafts(id: string) {
    const belongs = (key: string) => key === id || key.startsWith(`thread:${id}:`) || key.startsWith(`session:${id}:`);
    setAcknowledgedDrafts(old => Object.fromEntries(Object.entries(old).filter(([key]) => !belongs(key))));
    for (const key of messageAttempts.current.keys()) if (belongs(key)) messageAttempts.current.delete(key);
    draftState.current = Object.fromEntries(Object.entries(draftState.current).filter(([key]) => !belongs(key)));
    persistComposerDrafts(viewer, draftState.current);
    for (const [id, job] of uploadJobs.current) if (belongs(job.key)) { uploadJobs.current.delete(id); job.controller.abort(); }
    attachmentState.current = Object.fromEntries(Object.entries(attachmentState.current).filter(([key]) => !belongs(key)));
    setAttachmentDrafts(attachmentState.current);
  }
  return { draftState, saveDraft, uploads, forgetChannelDrafts };
}
