import { useState, useSyncExternalStore } from 'react';
import { Tabs, Button } from '@space/ui/primitives';
import { RichContent, type Attachment } from '@space/ui/rich-text';
import { PencilSimple } from '@phosphor-icons/react';
import type { ComposerDrafts as Drafts } from './composer-drafts.js';
import { destination, type DraftSync } from './draft-sync.js';
import { WorkspaceCollections } from '../workspace/collections/WorkspaceCollections.js';
import { ScheduledMessages } from './ScheduledMessages.js';

type Props = {
  workspace: string;
  drafts: Drafts;
  files: Record<string, Attachment[]>;
  locked: Record<string, boolean>;
  sync: DraftSync;
  onDiscard: (key: string) => void;
  onOpen: (item: { channel_id: string; message_id?: string; thread_id?: string }) => void;
  onNewMessage: () => void;
};

export function ComposerDrafts({ workspace, drafts, files, locked, sync, onDiscard, onOpen, onNewMessage }: Props) {
  useSyncExternalStore(sync.subscribe, sync.snapshot);
  const [tab, setTab] = useState('drafts');
  const keys = new Set([...Object.keys(drafts), ...Object.keys(files), ...Object.keys(locked), ...sync.conflicts, ...sync.failures.keys()]);
  const items = [...keys].flatMap(key => {
    const room = destination(key), meta = sync.metadata(key);
    if (!room || meta?.workspace_id !== workspace) return [];
    const document = drafts[key], attachments = files[key] ?? [];
    const conflict = sync.conflicts.has(key), failure = sync.failures.get(key);
    if (!locked[key] && !conflict && !failure && !attachments.length && !document?.ops.some(op => op.insert.trim())) return [];
    return [{ key, room, document, attachments, conflict, failure, name: meta.destination_name }];
  });
  const retry = <Button size="sm" onClick={() => void sync.retry()}>Retry</Button>;
  return <section className="composer-drafts">
    <header><h1>Drafts &amp; sent</h1></header>
    <Tabs label="Outgoing messages" value={tab} onChange={setTab} items={[
      { id: 'drafts', label: 'Drafts' }, { id: 'scheduled', label: 'Scheduled' }, { id: 'sent', label: 'Sent' },
    ]}/>
    {tab === 'sent' ? <WorkspaceCollections view="sent" workspace={workspace} onOpen={onOpen}/>
      : tab === 'scheduled' ? <ScheduledMessages workspace={workspace} onOpen={onOpen}/>
      : <main id="chat-messages" tabIndex={-1} className="composer-drafts-body">
        {sync.loadError && <p role="alert">Couldn’t load your drafts. {retry}</p>}
        {!!sync.failures.size && <p role="status">Some drafts haven’t synced. {retry}</p>}
        {items.length ? <ul>{items.map(({ key, room, document, attachments, conflict, failure, name }) =>
          <li key={key}>
            <button onClick={() => onOpen({ channel_id: room.channel, ...(room.thread && { thread_id: room.thread }) })}>
              <strong>{name}{room.thread && ' · Thread'}</strong>
              {locked[key] ? <p>Link this device to read this encrypted draft.</p> : <>
                {document && <RichContent document={document}/>}
                {!!attachments.length && <p>{attachments.map(file => file.name).join(', ')}</p>}
              </>}
            </button>
            {conflict ? <div className="draft-actions" role="alert">
              <span>This draft changed on another device.</span>
              <Button size="sm" onClick={() => void sync.resolve(key, true)}>Keep this device’s version</Button>
              <Button size="sm" onClick={() => void sync.resolve(key, false)}>Use other device’s version</Button>
            </div> : <div className="draft-actions">
              {failure && <span role="alert">{failure.replaceAll('_', ' ')}</span>}
              {!locked[key] && <Button size="sm" variant="ghost" onClick={() => onDiscard(key)}>Delete draft</Button>}
            </div>}
          </li>)}</ul> : !sync.loaded && !sync.loadError ? <p role="status">Loading drafts…</p>
            : !sync.loadError && <div className="composer-drafts-empty"><PencilSimple size={46}/><h2>Draft messages to send when you’re ready</h2>
              <p>Start a message in a channel, DM, or thread and pick it up here.</p><Button onClick={onNewMessage}>New message</Button></div>}
      </main>}
  </section>;
}
