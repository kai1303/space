import { useState, type FormEvent } from 'react';
import { Button, Dialog } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import { errorText } from '../../shared/api/error-text.js';
import { invalidateUpdates } from '../../shared/realtime/live-updates.js';

export function RenameSessionDialog({ id, title, workspace, thread, viewerId, onClose }: {
  id: string; title: string; workspace: string; thread: string; viewerId: string; onClose: () => void;
}) {
  const [previousTitle] = useState(title);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (saving || !next || next === previousTitle) return;
    setSaving(true);
    setError('');
    try {
      await request(`/agent-sessions/${id}`, { title: next, previous_title: previousTitle }, undefined, 'PATCH', undefined, viewerId);
      void invalidateUpdates('thread', thread);
      void invalidateUpdates('workspace', workspace);
      onClose();
    } catch (reason) {
      setSaving(false);
      setError(reason instanceof Error && reason.message === 'session_title_changed'
        ? 'Someone renamed this session. Reopen Rename to edit the latest title.' : errorText(reason));
    }
  }
  return <Dialog open title="Rename session" onClose={onClose} onBeforeClose={() => !saving}>
    <form className="chat-form" onSubmit={save}>
      <label>Session title<input autoFocus required maxLength={160} value={draft}
        onFocus={event => event.target.select()} onChange={event => setDraft(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <div className="chat-form-actions">
        <Button disabled={saving} onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!draft.trim() || draft.trim() === previousTitle || saving}>Save</Button>
      </div>
    </form>
  </Dialog>;
}
