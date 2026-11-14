import { useRef, useState } from 'react';
import { Button } from '@space/ui/primitives';

export type PatchAnchor = { path: string; patch: string; index: number; location: string; line: string };
export type SubmitReview = (text: string, idempotencyKey: string) => Promise<void>;

export function patchLines(patch: string) {
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  return patch.split('\n').map((line, index) => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    let location = `patch line ${index + 1}`;
    let oldNumber: number | undefined, newNumber: number | undefined;
    let kind: 'removed' | 'added' | 'context' | 'meta' = 'meta';
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
    } else if (line.startsWith('-') && oldRemaining > 0) {
      kind = 'removed'; oldNumber = oldLine;
      location = `old line ${oldLine++}`; oldRemaining--;
    } else if (line.startsWith('+') && newRemaining > 0) {
      kind = 'added'; newNumber = newLine;
      location = `new line ${newLine++}`; newRemaining--;
    } else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      kind = 'context'; oldNumber = oldLine; newNumber = newLine;
      location = `line ${newLine++}`; oldLine++; oldRemaining--; newRemaining--;
    }
    // Some providers emit a partial patch without a unified hunk header.
    if (kind === 'meta' && line.startsWith('+') && !line.startsWith('+++')) kind = 'added';
    if (kind === 'meta' && line.startsWith('-') && !line.startsWith('---')) kind = 'removed';
    return { line, location, index, kind, oldNumber, newNumber };
  });
}

type Note = PatchAnchor & { text: string; digest: string; id: string };
function reviewMessage(notes: Note[]) {
  return 'Code review\n\n' + notes.map(note =>
    `${note.path} · ${note.location} (patch line ${note.index + 1}, sha256:${note.digest})\n> ${note.line.slice(0, 160)}${note.line.length > 160 ? '…' : ''}\n${note.text}`
  ).join('\n\n');
}

export function usePatchReview(onReview?: SubmitReview) {
  const [anchor, setAnchor] = useState<PatchAnchor>();
  const [text, setText] = useState(''), [notes, setNotes] = useState<Note[]>([]);
  const [confirmation, setConfirmation] = useState<Note[]>();
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const lock = useRef(false), attempt = useRef<{message: string; key: string} | undefined>(undefined);
  function select(line: PatchAnchor) {
    if (lock.current || (anchor && text.trim())) return;
    setAnchor(line); setText(''); setError('');
  }
  async function add(confirmSingle = false) {
    if (!anchor || !text.trim() || lock.current) return;
    lock.current = true; setPending(true); setError('');
    try {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(anchor.patch));
      const digest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
      const next = [...notes, {...anchor, digest, text: text.trim(), id: crypto.randomUUID()}];
      if (reviewMessage(next).length > 4000) throw new Error('Review is full. Shorten a comment or send the current review first.');
      setNotes(next);
      if (confirmSingle) setConfirmation(next);
      setAnchor(undefined); setText('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add this comment.'); }
    finally { lock.current = false; setPending(false); }
  }
  async function send() {
    if (!onReview || !confirmation?.length || lock.current) return;
    const message = reviewMessage(confirmation);
    if (message.length > 4000) { setError('Shorten your review before sending.'); return; }
    if (attempt.current?.message !== message) attempt.current = {message, key: crypto.randomUUID()};
    lock.current = true; setPending(true); setError('');
    try {
      await onReview(message, attempt.current.key);
      attempt.current = undefined; setNotes([]); setConfirmation(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send this review.'); }
    finally { lock.current = false; setPending(false); }
  }
  const summary = onReview && notes.length > 0 && (confirmation ? <form className="agent-patch-review agent-patch-review-confirm" aria-label="Review before sending"
    onSubmit={event => {event.preventDefault(); void send();}}>
    <strong>Review before sending</strong>
    {confirmation.map((note, index) => <label key={note.id}>{note.path} · {note.location}
      <textarea required maxLength={2000} autoFocus={index === 0} disabled={pending} value={note.text}
        aria-label={confirmation.length === 1 ? 'Review message' : `Review message for ${note.path}, ${note.location}`}
        onChange={event => setConfirmation(confirmation.map(item => item.id === note.id ? {...item, text:event.target.value} : item))}/>
    </label>)}
    {error && <p role="alert">{error}</p>}
    <div><Button size="sm" type="submit" disabled={pending || confirmation.some(note => !note.text.trim())}>Send review</Button>
      <Button size="sm" type="button" variant="ghost" disabled={pending} onClick={() => {setNotes(confirmation);setConfirmation(undefined);setError('');}}>Back to comments</Button>
    </div>
  </form> : <section aria-label="Pending code review" className="agent-patch-review">
    <header><strong>Pending review ({notes.length})</strong>
      <Button size="sm" disabled={pending || !!anchor} onClick={() => {setError('');setConfirmation(notes);}}>Submit review</Button></header>
    <ol>{notes.map(note => <li key={note.id}>
      <div><b>{note.path} · {note.location}</b><p>{note.text}</p></div>
      <Button size="sm" variant="ghost" disabled={pending} aria-label={`Remove comment on ${note.path}, ${note.location}`} onClick={() => setNotes(current => current.filter(item => item.id !== note.id))}>Remove</Button>
    </li>)}</ol>
    {error && !anchor && <p role="alert">{error}</p>}
  </section>);
  const editor = onReview && anchor && <form className="agent-patch-review agent-patch-review-editor" onSubmit={event => {event.preventDefault(); void add();}}>
    <label>Comment on {anchor.path}, {anchor.location}<code>{anchor.line}</code>
      <textarea autoFocus required maxLength={2000} value={text} disabled={pending} onChange={event => setText(event.target.value)}/>
    </label>
    <div>
      {!notes.length && <Button type="button" size="sm" disabled={pending || !text.trim()} onClick={() => void add(true)}>Send comment</Button>}
      <Button type="submit" size="sm" disabled={pending || !text.trim()}>Add to review</Button>
      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => {setAnchor(undefined);setText('');setError('');}}>Cancel comment</Button>
    </div>
    {error && <p role="alert">{error}</p>}
  </form>;
  return { select, anchor, editor, summary, disabled: pending || !!confirmation || Boolean(anchor && text.trim()) };
}
