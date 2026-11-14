import { useState, useSyncExternalStore } from 'react';
import { Tabs, Button, Dialog, IconButton, toast } from '@space/ui/primitives';
import { RichContent, type Attachment } from '@space/ui/rich-text';
import { Clock, PaperPlaneRight, PencilSimple, Trash } from '@phosphor-icons/react';
import type { ComposerDrafts as Drafts } from './composer-drafts.js';
import { destination, type DraftSync } from './draft-sync.js';
import { WorkspaceCollections } from '../workspace/collections/WorkspaceCollections.js';
import { DraftScheduleDialog } from './DraftScheduleDialog.js';
import { scheduledLabel } from './scheduled-messages.js';
import { ScheduledMessages } from './ScheduledMessages.js';

type Props = {
  workspace: string;
  drafts: Drafts;
  files: Record<string, Attachment[]>;
  locked: Record<string, boolean>;
  sync: DraftSync;
  onDiscard: (key: string) => void;
  onOpen: (item: { channel_id: string; message_id?: string; thread_id?: string }) => void;
  onEdit: (key: string) => void;
  onNewMessage: () => void;
};

export function ComposerDrafts({ workspace, drafts, files, locked, sync, onDiscard, onOpen, onEdit, onNewMessage }: Props) {
  useSyncExternalStore(sync.subscribe, sync.snapshot);
  const [tab, setTab] = useState('drafts');
  const [confirm, setConfirm] = useState<{key: string; revision: string; label: string; broadcast: boolean}>();
  const [deleting, setDeleting] = useState<{key: string; content: string; label?: string}>();
  const [deleteClosing, setDeleteClosing] = useState(false);
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const [scheduling, setScheduling] = useState<{key: string; revision: string}>();
  const keys = new Set([...Object.keys(drafts), ...Object.keys(files), ...Object.keys(locked), ...sync.conflicts, ...sync.failures.keys()]);
  const items = [...keys].flatMap(key => {
    const room = destination(key), meta = sync.metadata(key);
    const newMessage = key === `new-direct:${workspace}`;
    if (!newMessage && (!room || meta?.workspace_id !== workspace)) return [];
    const document = drafts[key], attachments = files[key] ?? [];
    const conflict = sync.conflicts.has(key), failure = sync.failures.get(key);
    if (!locked[key] && !conflict && !failure && !attachments.length && !document?.ops.some(op => op.insert.trim())) return [];
    if (sync.sending.has(key) && sync.sending.get(key) === meta?.revision) return [];
    const revision = attachments.some(file => file.status && file.status !== 'ready') ? null : sync.sendableRevision(key);
    return [{ key, room, document, attachments, conflict, failure, revision, name: newMessage ? 'New message' : meta?.destination_name }];
  });
  function edit(key: string) {
    if (key === `new-direct:${workspace}`) onNewMessage();
    else onEdit(key);
  }
  // Ignore upload progress while comparing the content the user chose to delete.
  function deleteContent(key: string) {
    return JSON.stringify([drafts[key]?.ops, (files[key] ?? []).map(file => [file.draftId ?? file.id, file.description])]);
  }
  const deleteRow = deleting && items.find(item => item.key === deleting.key);
  const canDelete = !!deleteRow && !deleteRow.conflict && !locked[deleteRow.key] && deleteContent(deleteRow.key) === deleting?.content;
  const confirmedRow = items.find(item => item.key === confirm?.key && item.revision === confirm.revision);
  async function send() {
    if (!confirm || !confirmedRow || !confirm.revision) return;
    const {key, revision, broadcast, label} = confirm;
    setConfirm(undefined);
    try {
      await sync.deliver(key, revision, broadcast);
      toast.success('Message sent');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Please try again.';
      toast.error('Couldn’t send message', {description: reason === 'draft_conflict'
        ? 'Your draft changed on another device. Review the latest version before sending.'
        : `${label} · ${reason.replaceAll('_', ' ')}`});
    }
  }
  async function schedule(at: Date) {
    if (!scheduling) return;
    const {key, revision} = scheduling;
    setScheduling(undefined);
    try {
      await sync.deliver(key, revision, false, at);
      setScheduleVersion(version => version + 1);
      toast.success(`Scheduled for ${scheduledLabel(at)}`, {description:'See it in Scheduled.'});
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const reason: Record<string,string> = {
        draft_conflict: 'Your draft changed on another device. Review it before scheduling.',
        too_many_scheduled_messages: 'You have 100 scheduled messages. Send or cancel one, then try again.',
        asset_unavailable: 'A file is no longer available. Open your draft to update it.',
        draft_schedule_too_soon: 'Choose a time at least five minutes from now.',
        channel_archived: 'This channel is archived.',
      };
      toast.error('Couldn’t schedule message', {description:reason[code] ?? 'Your message is available in Drafts. Try again.'});
    }
  }
  const retry = <Button size="sm" onClick={() => void sync.retry()}>Retry</Button>;
  return <section className="composer-drafts">
    <header><h1>Drafts &amp; sent</h1></header>
    <Tabs label="Outgoing messages" value={tab} onChange={setTab} items={[
      { id: 'drafts', label: 'Drafts' }, { id: 'scheduled', label: 'Scheduled' }, { id: 'sent', label: 'Sent' },
    ]}/>
    {tab === 'sent' ? <WorkspaceCollections view="sent" workspace={workspace} onOpen={onOpen}/>
      : tab === 'scheduled' ? <ScheduledMessages key={scheduleVersion} workspace={workspace} onOpen={onOpen}/>
      : <main id="chat-messages" tabIndex={-1} className="composer-drafts-body">
        {sync.loadError && <p role="alert">Couldn’t load your drafts. {retry}</p>}
        {!!sync.failures.size && <p role="status">Some drafts haven’t synced. {retry}</p>}
        {items.length ? <ul>{items.map(({ key, room, document, attachments, conflict, failure, revision, name }) =>
          <li className="draft-row" key={key}>
            <button onClick={() => edit(key)}>
              <strong>{name}{room?.thread && ' · Thread'}</strong>
              {locked[key] ? <p>Link this device to read this encrypted draft.</p> : <>
                {document && <RichContent document={document}/>}
                {!!attachments.length && <p>{attachments.map(file => file.name).join(', ')}</p>}
              </>}
            </button>
            {conflict ? <div className="draft-actions" role="alert">
              <span>This draft changed on another device.</span>
              <Button size="sm" onClick={() => void sync.resolve(key, true)}>Keep this device’s version</Button>
              <Button size="sm" onClick={() => void sync.resolve(key, false)}>Use other device’s version</Button>
            </div> : <div className="draft-actions draft-row-tools" role="group" aria-label="Draft actions">
              {failure && <span role="alert">{failure.replaceAll('_', ' ')}</span>}
              {!locked[key] && <>
                <IconButton size="sm" label="Delete draft" onClick={() => setDeleting({key, content:deleteContent(key), label:room ? name : undefined})}><Trash size={17}/></IconButton>
                <IconButton size="sm" label="Edit draft" onClick={() => edit(key)}><PencilSimple size={18}/></IconButton>
                {room && !room.encrypted && <IconButton size="sm" label="Schedule message" disabled={!revision}
                  onClick={() => revision && setScheduling({key, revision})}><Clock size={18}/></IconButton>}
                {room && <IconButton size="sm" label="Send message" disabled={!revision} onClick={() => revision && setConfirm({
                  key, revision, label: room.thread ? `the thread in ${name}` : name ?? 'this conversation',
                  broadcast: !!document?.ops.some(op => op.attributes?.mention?.kind === 'broadcast'),
                })}><PaperPlaneRight size={18}/></IconButton>}
              </>}
            </div>}
          </li>)}</ul> : !sync.loaded && !sync.loadError ? <p role="status">Loading drafts…</p>
            : sync.sending.size ? <p role="status" className="composer-drafts-hint">Updating drafts…</p> : !sync.loadError && <div className="composer-drafts-empty"><PencilSimple size={46}/><h2>Draft messages to send when you’re ready</h2>
              <p>Start a message in a channel, DM, or thread and pick it up here.</p><Button onClick={onNewMessage}>New message</Button></div>}
      </main>}
    {deleting && <Dialog open={!deleteClosing} title="Delete draft?" onClose={() => {
      setDeleting(undefined);
      setDeleteClosing(false);
    }}>
      {canDelete || deleteClosing ? <p>Are you sure you want to delete this draft{deleting.label && <> to <strong>{deleting.label}</strong></>}?</p>
        : <p role="status">This draft changed. Review it before deleting.</p>}
      <div className="draft-send-footer">
        <Button onClick={() => setDeleteClosing(true)}>Cancel</Button>
        <Button variant="danger" className="draft-delete-confirm" ref={button => { if (button) button.autofocus = true; }} disabled={!canDelete || deleteClosing} onClick={() => {
          if (!canDelete || deleteClosing) return;
          setDeleteClosing(true);
          onDiscard(deleting.key);
        }}>Delete Draft</Button>
      </div>
    </Dialog>}
    {scheduling && <DraftScheduleDialog current={items.some(item => item.key === scheduling.key && item.revision === scheduling.revision)}
      onClose={() => setScheduling(undefined)} onSchedule={at => void schedule(at)}/>}
    {confirm && <Dialog open title="Send message" onClose={() => setConfirm(undefined)}>
      {confirmedRow ? <><p>Are you sure you want to send this message to <strong>{confirm.label}</strong>?</p>
        {confirm.broadcast && <p>This mention can notify everyone in the channel.</p>}</>
        : <p role="status">This draft changed. Review it before sending.</p>}
      <div className="draft-send-footer">
        <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
        <Button variant="primary" autoFocus disabled={!confirmedRow} onClick={() => void send()}>Send</Button>
      </div>
    </Dialog>}
  </section>;
}
