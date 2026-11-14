import { useEffect, useState } from 'react';
import { Clock, PaperPlaneRight, PencilSimple, Trash, Warning } from '@phosphor-icons/react';
import type { ScheduledMessage } from '@space/contracts';
import { Button, toast } from '@space/ui/primitives';
import { RichContent } from '@space/ui/rich-text';
import { scheduleError } from '@space/ui/composer';
import { request } from '../../shared/api/request.js';
import { errorText } from '../../shared/api/error-text.js';
import { scheduledLabel } from './scheduled-messages.js';

const failure: Record<string, string> = {
  not_found: 'You no longer have access to this conversation.',
  channel_archived: 'The channel was archived.',
  asset_unavailable: 'A file was no longer available.',
  channel_posting_forbidden: 'You can no longer post in this channel.',
  channel_replies_forbidden: 'You can no longer reply in this channel.',
};
const localInput = (at: string) => { const date = new Date(at); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

// Slack's Scheduled list: what is waiting, when it goes out, and Send now / Edit time / Cancel.
export function ScheduledMessages({ workspace, onOpen }: { workspace: string; onOpen: (item: { channel_id: string; thread_id?: string }) => void }) {
  const [items, setItems] = useState<ScheduledMessage[]>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [editing, setEditing] = useState<{ id: string; value: string; error: string }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    request<{ items: ScheduledMessage[] }>(`/workspaces/${workspace}/scheduled-messages`)
      .then(result => { if (active) setItems(result.items); })
      .catch(reason => { if (active) { setItems([]); setError(errorText(reason)); } });
    return () => { active = false; };
  }, [workspace, revision]);
  async function act(id: string, run: () => Promise<ScheduledMessage>) {
    setBusy(id); setError('');
    try {
      const updated = await run();
      if (updated.status === 'cancelled') toast.success('Scheduled message canceled');
      setItems(list => (list ?? []).flatMap(item => item.id !== id ? [item] : updated.status === 'cancelled' ? [] : [updated]));
    } catch (reason) { setError(errorText(reason)); setRevision(n => n + 1); }
    finally { setBusy(''); }
  }
  if (!items) return <main id="chat-messages" tabIndex={-1} className="composer-drafts-body"><p role="status">Loading scheduled messages…</p></main>;
  return <main id="chat-messages" tabIndex={-1} className="composer-drafts-body">
    {error && <p role="alert">{error}<Button onClick={() => setRevision(n => n + 1)}>Retry</Button></p>}
    {!items.length ? <div className="composer-drafts-empty"><Clock size={46} /><h2>No scheduled messages</h2><p>Choose “Schedule for later” beside Send to pick a time. Scheduled messages wait here until they go out.</p></div>
      : <ul className="scheduled-messages">{items.map(item => <li key={item.id}>
        <div className="scheduled-message">
          <button type="button" className="scheduled-message-target" onClick={() => onOpen({ channel_id: item.channel_id, ...(item.thread_id ? { thread_id: item.thread_id } : {}) })}>
            <strong>#{item.channel_name}{item.thread_id ? ' · Thread' : ''}</strong>
            <span className={item.status === 'failed' ? 'scheduled-message-when is-failed' : 'scheduled-message-when'}>
              {item.status === 'failed' ? <><Warning size={14} aria-hidden="true" />Not sent: {failure[item.error ?? ''] ?? item.error}</> : <><Clock size={14} aria-hidden="true" />{item.status === 'sending' ? 'Sending…' : scheduledLabel(item.send_at)}</>}
            </span>
          </button>
          {item.document ? <RichContent document={item.document} /> : item.text && <p>{item.text}</p>}
          {item.attachments.length > 0 && <p className="scheduled-message-files">{item.attachments.map(file => file.name).join(', ')}</p>}
          {editing?.id === item.id ? <form className="scheduled-message-edit" noValidate onSubmit={event => {
              event.preventDefault();
              const at = new Date(editing.value), problem = scheduleError(at);
              if (problem) { setEditing({ ...editing, error: problem }); return; }
              setEditing(undefined);
              void act(item.id, () => request<ScheduledMessage>(`/scheduled-messages/${item.id}`, { send_at: at.toISOString() }, undefined, 'PATCH'));
            }}>
              <label>New time<input type="datetime-local" value={editing.value} onChange={event => setEditing({ ...editing, value: event.target.value, error: '' })} /></label>
              {editing.error && <p role="alert">{editing.error}</p>}
              <Button type="submit" size="sm" variant="primary">Save time</Button><Button size="sm" onClick={() => setEditing(undefined)}>Keep current time</Button>
            </form>
            : item.status !== 'sending' && <div className="scheduled-message-actions">
              <Button size="sm" loading={busy === item.id} onClick={() => void act(item.id, () => request<ScheduledMessage>(`/scheduled-messages/${item.id}/send`, {}))}><PaperPlaneRight size={16} />Send now</Button>
              <Button size="sm" disabled={!!busy} onClick={() => setEditing({ id: item.id, value: localInput(item.send_at), error: '' })}><PencilSimple size={16} />Edit time</Button>
              <Button size="sm" variant="danger" disabled={!!busy} onClick={() => void act(item.id, () => request<ScheduledMessage>(`/scheduled-messages/${item.id}`, undefined, undefined, 'DELETE'))}><Trash size={16} />Cancel</Button>
            </div>}
        </div>
      </li>)}</ul>}
  </main>;
}
