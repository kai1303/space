import { useId, useState, type FormEvent } from 'react';
import { Button, Dialog, Select } from '@space/ui/primitives';
import type { ChannelMember, ChannelPermissionSnapshot } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates } from '../../shared/realtime/live-updates.js';

export const postingLabels = { everyone: 'Everyone', members: 'Everyone except guests', admins: 'Admins only', selected: 'Admins plus specific people' } as const;
export type PermissionSection = 'posting' | 'managers' | 'actions';
const actionLabels = { invite: 'Invite people', remove: 'Remove people', edit_details: 'Edit channel details', archive: 'Archive and restore channel' } as const;
export function ChannelPermissionEditor({ channel, snapshot, members, section, canEdit = true, onClose, onSaved }: { channel: string; snapshot: ChannelPermissionSnapshot; members: ChannelMember[]; section: PermissionSection; canEdit?: boolean; onClose: () => void; onSaved: (snapshot: ChannelPermissionSnapshot) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(snapshot), [busy, setBusy] = useState(false), [error, setError] = useState(''), [open, setOpen] = useState(true), [query, setQuery] = useState(''), [reloadRequired, setReloadRequired] = useState(false);
  function toggle(field: 'manager_ids' | 'poster_ids', value: string) { setDraft(current => ({ ...current, [field]: current[field].includes(value) ? current[field].filter(entry => entry !== value) : [...current[field], value].slice(0, 100) })); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !canEdit || reloadRequired) return; setBusy(true); setError('');
    const fields = section === 'posting' ? { posting: draft.posting, poster_ids: draft.posting === 'selected' ? draft.poster_ids : [], allow_replies: draft.posting === 'everyone' ? true : draft.allow_replies, allow_broadcast: draft.allow_broadcast } : section === 'managers' ? { manager_ids: draft.manager_ids } : { invite: draft.invite, remove: draft.remove, edit_details: draft.edit_details, archive: draft.archive };
    try {
      const saved = await request<ChannelPermissionSnapshot>(`/channels/${channel}/permissions`, { revision: draft.revision, ...fields }, undefined, 'PATCH');
      onSaved(saved); await invalidateUpdates('channel', channel); setOpen(false);
    } catch (reason) {
      if (reason instanceof Error && reason.message === 'channel_permissions_conflict') {
        try {
          setDraft(await request<ChannelPermissionSnapshot>(`/channels/${channel}/permissions`));
          setError('Permissions changed while you were editing. Review the latest settings and save again.');
        } catch { setReloadRequired(true); setError('Permissions changed. Close and reopen this editor to reload the latest settings.'); }
      } else setError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Unable to save permissions.');
    } finally { setBusy(false); }
  }
  const peopleField = section === 'managers' ? 'manager_ids' : 'poster_ids';
  const candidates = members.filter(member => (section !== 'managers' || !member.guest_type || member.guest_type === 'none') && member.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Dialog open={open} title={section === 'posting' ? 'Posting permissions' : section === 'managers' ? 'Channel managers' : 'Member permissions'} onBeforeClose={() => !busy} onClose={onClose}>
    <form className="space-channel-editor space-channel-permissions" onSubmit={save}>
      <fieldset disabled={busy || !canEdit || reloadRequired}>
        {section === 'posting' && <>
          <legend>Who can post in this channel?</legend>
          <div className="space-channel-permission-options">{(Object.keys(postingLabels) as Array<keyof typeof postingLabels>).map(value => <label key={value}><input type="radio" name={`${id}-posting`} value={value} checked={draft.posting === value} onChange={() => setDraft(current => ({ ...current, posting: value }))} />{postingLabels[value]}</label>)}</div>
        </>}
        {(section === 'managers' || (section === 'posting' && draft.posting === 'selected')) && <div className="space-channel-permission-people">
          <label>Find channel members<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <p className="space-channel-muted">{section === 'managers' ? 'Managers can change channel permissions. Guests cannot be managers.' : 'Workspace admins and these people can post.'} Choose up to 100 people.</p>
          <div className="space-channel-candidates">{candidates.map(member => <label key={member.id}><input type="checkbox" aria-label={member.name} checked={draft[peopleField].includes(member.id)} disabled={!draft[peopleField].includes(member.id) && draft[peopleField].length >= 100} onChange={() => toggle(peopleField, member.id)} />{member.name}</label>)}</div>
          {!candidates.length && <p className="space-channel-muted">No eligible members match your search.</p>}
        </div>}
        {section === 'posting' && draft.posting !== 'everyone' && <label className="space-channel-permission-check"><input type="checkbox" aria-label="Allow threads" checked={draft.allow_replies} onChange={event => setDraft(current => ({ ...current, allow_replies: event.target.checked }))} /><span>Allow threads<small>Everyone in this channel can reply, regardless of who can post.</small></span></label>}
        {section === 'posting' && <label className="space-channel-permission-check space-channel-permission-broadcast"><input type="checkbox" aria-label="Allow @everyone, @here and @channel" checked={draft.allow_broadcast} onChange={event => setDraft(current => ({ ...current, allow_broadcast: event.target.checked }))} /><span>Allow @everyone, @here and @channel<small>Workspace mention permissions still apply.</small></span></label>}
        {section === 'actions' && <>{(Object.keys(actionLabels) as Array<keyof typeof actionLabels>).map(field => <label className="space-channel-permission-policy" key={field}>{actionLabels[field]}<Select aria-label={actionLabels[field]} value={draft[field]} onChange={event => setDraft(current => ({ ...current, [field]: event.target.value }))}><option value="managers">Channel managers</option><option value="members">Full members</option></Select></label>)}</>}
      </fieldset>
      {!canEdit && <p role="status" className="space-channel-muted">Channel permissions are being checked or your access to manage this channel has changed.</p>}
      {error && <p className="space-channel-error" role="alert">{error}</p>}
      <footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!canEdit || reloadRequired}>Save</Button></footer>
    </form>
  </Dialog>;
}
