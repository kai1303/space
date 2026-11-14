import { useState, type FormEvent } from 'react';
import { Smiley, X } from '@phosphor-icons/react';
import { EmojiPicker } from '@space/ui/emoji';
import { Button, Dialog, IconButton } from '@space/ui/primitives';
import { errorText } from '../../shared/api/error-text.js';

export type SectionEdit =
  | { action: 'create'; id: string; channel?: string }
  | { action: 'rename' | 'delete'; id: string; name: string; emoji?: string };

export function SidebarSectionDialog({ edit, onSave, onClose }: {
  edit: SectionEdit; onSave: (name: string, emoji?: string) => Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState(edit.action === 'create' ? '' : edit.name);
  const [emoji, setEmoji] = useState(edit.action === 'create' ? undefined : edit.emoji);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const deleting = edit.action === 'delete';
  const title = edit.action === 'create' ? 'Create section' : deleting ? 'Delete section' : 'Rename section';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (!deleting && !name.trim())) return;
    setBusy(true);
    setError('');
    try {
      await onSave(name.trim(), emoji);
      onClose();
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  }
  return <Dialog open title={title} onClose={onClose} onBeforeClose={() => !busy}>
    <form className="chat-form" onSubmit={submit}>
      {deleting ? <p>Delete “{name}”? Its conversations will return to their usual sidebar sections.</p> :
        <div className="sidebar-section-fields">
          <label htmlFor="sidebar-section-name">Section name</label>
          <div className="sidebar-section-name-row">
            <EmojiPicker label="Choose section emoji" disabled={busy} trigger={emoji ?? <Smiley size={20}/>} onSelect={setEmoji}/>
            <input id="sidebar-section-name" autoFocus required maxLength={80} value={name} placeholder="e.g. Projects"
              onChange={event => setName(event.target.value)}/>
            {emoji && <IconButton label="Remove section emoji" onClick={() => setEmoji(undefined)}><X size={16}/></IconButton>}
          </div>
          {edit.action === 'create' && <div className="sidebar-section-suggestions" role="group" aria-label="Suggested section names">
            {['Projects', 'Team', 'Priorities'].map(suggestion => <Button key={suggestion} type="button" size="sm"
              aria-pressed={name === suggestion} onClick={() => setName(suggestion)}>{suggestion}</Button>)}
          </div>}
        </div>}
      {error && <p role="alert">{error}</p>}
      <div className="chat-form-actions">
        <Button disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={busy || (!deleting && !name.trim())}>{edit.action === 'create' ? 'Create' : title}</Button>
      </div>
    </form>
  </Dialog>;
}
