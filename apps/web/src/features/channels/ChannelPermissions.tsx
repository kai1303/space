import { useId, useRef, useState, type FormEvent } from 'react';
import { Button, Dialog, Select, toast } from '@space/ui/primitives';
import type { ChannelMember, ChannelPermissionSnapshot } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates } from '../../shared/realtime/live-updates.js';

export const postingLabels = { everyone: 'Everyone', members: 'Everyone except guests', admins: 'Admins only', selected: 'Admins plus specific people' } as const;
export type PermissionSection = 'posting' | 'managers' | 'actions';
const actionLabels = { invite: 'Invite people', remove: 'Remove people', edit_details: 'Edit channel details', archive: 'Archive and restore channel' } as const;
// Keep edits made after submission while adopting the server’s revision and other changes.
function applyLaterEdits(server: ChannelPermissionSnapshot, submitted: ChannelPermissionSnapshot, latest: ChannelPermissionSnapshot) {
  const next = { ...server };
  if (latest.posting !== submitted.posting) next.posting = latest.posting;
  for (const key of ['allow_replies', 'allow_broadcast'] as const) {
    if (latest[key] !== submitted[key]) next[key] = latest[key];
  }
  for (const key of Object.keys(actionLabels) as Array<keyof typeof actionLabels>) {
    if (latest[key] !== submitted[key]) next[key] = latest[key];
  }
  for (const key of ['manager_ids', 'poster_ids'] as const) {
    if (latest[key] === submitted[key]) continue;
    next[key] = [...new Set([
      ...server[key].filter(id => !submitted[key].includes(id) || latest[key].includes(id)),
      ...latest[key].filter(id => !submitted[key].includes(id)),
    ])];
  }
  return next;
}
export function ChannelPermissionEditor({ channel, snapshot, members, section, canEdit = true, onClose, onSaved }: { channel: string; snapshot: ChannelPermissionSnapshot; members: ChannelMember[]; section: PermissionSection; canEdit?: boolean; onClose: () => void; onSaved: (snapshot: ChannelPermissionSnapshot) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(snapshot), [pending, setPending] = useState<'save' | 'reload'>(), [error, setError] = useState(''), [open, setOpen] = useState(true), [query, setQuery] = useState(''), [reloadRequired, setReloadRequired] = useState(false);
  const latest = useRef(snapshot), submitting = useRef(false), dismissed = useRef(false);
  const busy = pending !== undefined;
  const locked = !canEdit || !draft.capabilities.manage || reloadRequired;
  const tooManyPeople = section === 'managers' ? draft.manager_ids.length > 100 : section === 'posting' && draft.posting === 'selected' && draft.poster_ids.length > 100;
  const progress = pending === 'reload' ? 'Refreshing permissions…' : section === 'managers' ? 'Saving managers…' : 'Saving permissions…';
  function edit(changes: Partial<ChannelPermissionSnapshot>) {
    latest.current = { ...latest.current, ...changes };
    setDraft(latest.current);
  }
  function toggle(field: 'manager_ids' | 'poster_ids', value: string) {
    const ids = latest.current[field];
    edit({ [field]: ids.includes(value) ? ids.filter(id => id !== value) : [...ids, value].slice(0, 100) });
  }
  function adopt(server: ChannelPermissionSnapshot) {
    latest.current = applyLaterEdits(server, draft, latest.current);
    setDraft(latest.current);
  }
  function report(message: string) {
    if (dismissed.current) toast.error(message);
    else setError(message);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || locked || tooManyPeople) return;
    submitting.current = true;
    setPending('save');
    setError('');
    const fields = section === 'posting' ? { posting: draft.posting, poster_ids: draft.posting === 'selected' ? draft.poster_ids : [], allow_replies: draft.posting === 'everyone' ? true : draft.allow_replies, allow_broadcast: draft.allow_broadcast } : section === 'managers' ? { manager_ids: draft.manager_ids } : { invite: draft.invite, remove: draft.remove, edit_details: draft.edit_details, archive: draft.archive };
    try {
      const saved = await request<ChannelPermissionSnapshot>(`/channels/${channel}/permissions`, { revision: draft.revision, ...fields }, undefined, 'PATCH');
      onSaved(saved);
      void invalidateUpdates('channel', channel);
      if (latest.current === draft) setOpen(false);
      else adopt(saved);
    } catch (reason) {
      if (reason instanceof Error && reason.message === 'channel_permissions_conflict') {
        try {
          setPending('reload');
          const current = await request<ChannelPermissionSnapshot>(`/channels/${channel}/permissions`);
          adopt(current);
          report('Permissions changed while you were editing. Review the latest settings and save again.');
        } catch { setReloadRequired(true); report('Permissions changed. Close and reopen this editor to reload the latest settings.'); }
      } else report(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Unable to save permissions.');
    } finally { submitting.current = false; setPending(undefined); }
  }
  const peopleField = section === 'managers' ? 'manager_ids' : 'poster_ids';
  const candidates = members.filter(member => (section !== 'managers' || !member.guest_type || member.guest_type === 'none') && member.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Dialog open={open} title={section === 'posting' ? 'Posting permissions' : section === 'managers' ? 'Channel managers' : 'Member permissions'} onClose={() => { dismissed.current = true; onClose(); }}>
    <form className="space-channel-editor space-channel-permissions" onSubmit={save}>
      <fieldset disabled={locked}>
        {section === 'posting' && <>
          <legend>Who can post in this channel?</legend>
          <div className="space-channel-permission-options">{(Object.keys(postingLabels) as Array<keyof typeof postingLabels>).map(value => <label key={value}><input type="radio" name={`${id}-posting`} value={value} checked={draft.posting === value} onChange={() => edit({ posting: value })} />{postingLabels[value]}</label>)}</div>
        </>}
        {(section === 'managers' || (section === 'posting' && draft.posting === 'selected')) && <div className="space-channel-permission-people">
          <label>Find channel members<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <p className="space-channel-muted">{section === 'managers' ? 'Managers can change channel permissions. Guests cannot be managers.' : 'Workspace admins and these people can post.'} Choose up to 100 people.</p>
          <div className="space-channel-candidates">{candidates.map(member => <label key={member.id}><input type="checkbox" aria-label={member.name} checked={draft[peopleField].includes(member.id)} disabled={!draft[peopleField].includes(member.id) && draft[peopleField].length >= 100} onChange={() => toggle(peopleField, member.id)} />{member.name}</label>)}</div>
          {!candidates.length && <p className="space-channel-muted">No eligible members match your search.</p>}
        </div>}
        {section === 'posting' && draft.posting !== 'everyone' && <label className="space-channel-permission-check"><input type="checkbox" aria-label="Allow threads" checked={draft.allow_replies} onChange={event => edit({ allow_replies: event.target.checked })} /><span>Allow threads<small>Everyone in this channel can reply, regardless of who can post.</small></span></label>}
        {section === 'posting' && <label className="space-channel-permission-check space-channel-permission-broadcast"><input type="checkbox" aria-label="Allow @everyone, @here and @channel" checked={draft.allow_broadcast} onChange={event => edit({ allow_broadcast: event.target.checked })} /><span>Allow @everyone, @here and @channel<small>Workspace mention permissions still apply.</small></span></label>}
        {section === 'actions' && <>{(Object.keys(actionLabels) as Array<keyof typeof actionLabels>).map(field => <label className="space-channel-permission-policy" key={field}>{actionLabels[field]}<Select aria-label={actionLabels[field]} value={draft[field]} onChange={event => edit({ [field]: event.target.value })}><option value="managers">Channel managers</option><option value="members">Full members</option></Select></label>)}</>}
      </fieldset>
      {(!canEdit || !draft.capabilities.manage) && <p role="status" className="space-channel-muted">Channel permissions are being checked or your access to manage this channel has changed.</p>}
      {tooManyPeople && <p role="alert">Choose at most 100 people before saving.</p>}
      {error && <p className="space-channel-error" role="alert">{error}</p>}
      <footer><Button onClick={() => { dismissed.current = true; setOpen(false); }}>{busy ? 'Close' : 'Cancel'}</Button><Button type="submit" variant="primary" loading={busy} disabled={locked || tooManyPeople}>{busy ? progress : 'Save'}</Button></footer>
      <span className="sp-sr-only" role="status">{busy && progress}</span>
    </form>
  </Dialog>;
}
