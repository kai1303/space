import { useMemberProfile } from '../profile/MemberProfile.js';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Avatar, Badge, Button, Dialog, Tabs } from '@space/ui/primitives';
import { Archive, Copy, Hash, Lock, MagnifyingGlass, UserPlus } from '@phosphor-icons/react';
import type { ChannelDetails as Details, ChannelMember, ChannelSummary, ChannelPermissionSnapshot, WorkspaceParticipant } from '@space/contracts';
import { listAll, request } from '../../shared/api/request.js';
import './channel-details.css';
import { ChannelPermissionEditor, postingLabels, type PermissionSection } from './ChannelPermissions.js';

const errorText = (error: unknown) => error instanceof Error ? error.message === 'channel_has_active_tasks'
  ? 'Resolve pending or running agent tasks before archiving this channel.' : error.message === 'channel_needs_manager'
  ? 'Assign another channel manager or add a workspace admin before leaving this private channel.' : error.message.replaceAll('_', ' ') : 'Unable to update channel';
type Props = { channel: ChannelSummary; viewer: string; open: boolean; initialTab?: string; permissions?: ChannelPermissionSnapshot; permissionsPending?: boolean; onClose: () => void; onChange: (channel: ChannelSummary) => void; onLeft: () => void };
type Field = 'name' | 'topic' | 'description';
export function ChannelDetails(props: Props) {
  return props.open ? <DetailsDialog key={props.channel.id} {...props} /> : null;
}
function DetailsDialog({ channel, viewer, initialTab = 'about', permissions, permissionsPending = false, onClose, onChange, onLeft }: Props) {
  const profiles = useMemberProfile();
  const [permissionEditor, setPermissionEditor] = useState<{ section: PermissionSection; snapshot: ChannelPermissionSnapshot }>();
  const id = useId();
  const [details, setDetails] = useState<Details>(), [members, setMembers] = useState<ChannelMember[]>([]);
  const [tab, setTab] = useState(initialTab), [query, setQuery] = useState(''), [error, setError] = useState('');
  const [field, setField] = useState<Field>(), [adding, setAdding] = useState(false), [copied, setCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<'archive' | 'leave' | ChannelMember>();
  async function refresh() {
    const [detail, people] = await Promise.all([request<Details>(`/channels/${channel.id}`), listAll<ChannelMember>(`/channels/${channel.id}/members`)]);
    setDetails(detail); setMembers(people);
    return detail;
  }
  useEffect(() => {
    let active = true;
    void Promise.all([request<Details>(`/channels/${channel.id}`), listAll<ChannelMember>(`/channels/${channel.id}/members`)]).then(([detail, people]) => {
      if (active) { setDetails(detail); setMembers(people); }
    }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [channel.id]);
  useEffect(() => { setDetails(previous => previous ? { ...previous, ...channel } : previous); }, [channel]);
  function saved(detail: Details) { setDetails(detail); onChange(detail); }
  const current = details ?? channel, archived = Boolean(current.archived_at);
  const policy = permissionsPending ? undefined : permissions ?? details?.permissions;
  const can = (action: keyof ChannelPermissionSnapshot['capabilities']) => !permissionsPending && (policy?.capabilities[action] ?? details?.can_manage ?? false);
  const isManager = (member: ChannelMember) => policy ? policy.manager_ids.includes(member.id) : !!member.is_manager;
  const editable = can('edit_details') && !archived;
  const filtered = members.filter(member => member.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <>
    <Dialog open title={`${current.private ? '🔒' : '#'} ${current.name}`} onClose={onClose}>
      <div className="space-channel-details">
        <div className="space-channel-meta"><Badge>{current.private ? 'Private channel' : 'Public channel'}</Badge>{archived && <Badge><Archive size={13} /> Archived</Badge>}<span>{details ? `${details.member_count} ${details.member_count === 1 ? 'member' : 'members'}` : 'Loading…'}</span></div>
        <Tabs label="Channel details" value={tab} onChange={setTab} items={[{ id: 'about', label: 'About', panelId: `${id}-about` }, { id: 'members', label: `Members${details ? ` ${details.member_count}` : ''}`, panelId: `${id}-members` }, { id: 'settings', label: 'Settings', panelId: `${id}-settings` }]} />
        {error && <div className="space-channel-error" role="alert">{error} <Button size="sm" onClick={() => { setError(''); void refresh().catch(e => setError(errorText(e))); }}>Retry</Button></div>}
        {!details && !error && <p className="space-channel-loading" role="status">Loading channel details…</p>}
        {details && <div id={`${id}-${tab}`} role="tabpanel" aria-label={tab === 'members' ? 'Members' : tab === 'settings' ? 'Settings' : 'About'} className="space-channel-body">
          {tab === 'about' && <>
            <div className="space-channel-card">
              {(['name', 'topic', 'description'] as const).map(key => <section key={key} aria-label={key === 'name' ? 'Channel name' : key === 'topic' ? 'Topic' : 'Description'}>
                <div className="space-channel-field-heading"><h3>{key === 'name' ? 'Channel name' : key === 'topic' ? 'Topic' : 'Description'}</h3>{editable && <button className="space-channel-link" aria-label={`Edit channel ${key}`} onClick={() => setField(key)}>Edit</button>}</div>
                <p className={!details[key] ? 'space-channel-muted' : undefined}>{key === 'name' && (details.private ? <Lock size={15} /> : <Hash size={15} />)}{details[key] || (key === 'topic' ? 'Add a topic' : 'Add a description')}</p>
              </section>)}
              {policy && <section><div className="space-channel-field-heading"><h3>Managed by</h3>{can('manage') && !archived && <button className="space-channel-link" aria-label="Edit channel managers" onClick={() => setPermissionEditor({ section: 'managers', snapshot: policy })}>Edit</button>}</div><p>{members.filter(isManager).map(member => member.name).join(', ') || 'Workspace admins'}</p></section>}
              <section><h3>Created by</h3><p>{details.creator_name ?? 'Workspace'} on {new Date(details.created_at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</p></section>
              <button className="space-channel-action space-channel-danger" onClick={() => setConfirmation('leave')}>Leave channel</button>
            </div>
            <div className="space-channel-id"><span>Channel ID: {channel.id}</span><button aria-label="Copy channel ID" title="Copy channel ID" onClick={() => { void navigator.clipboard.writeText(channel.id).then(() => setCopied(true)).catch(() => setError('Could not copy. Select the channel ID to copy it manually.')); }}><Copy size={15} /></button><span role="status">{copied ? 'Copied' : ''}</span></div>
          </>}
          {tab === 'members' && <>
            <label className="space-channel-search"><MagnifyingGlass size={18} /><input type="search" aria-label="Find channel members" placeholder="Find members" value={query} onChange={e => setQuery(e.target.value)} /></label>
            <ul className="space-channel-people" aria-label="Channel members">
              {can('invite') && !archived && <li><button className="space-channel-add" onClick={() => setAdding(true)}><span><UserPlus size={22} /></span>Add people</button></li>}
              {filtered.map(member => <li key={member.id}>
                <button type="button" className="space-profile-trigger" aria-label={`View ${member.name}’s profile`} onClick={() => {onClose(); profiles?.open({kind:'user',id:member.id});}}><MemberAvatar member={member} /><div><strong>{member.name}{member.id === viewer && <span className="space-channel-muted"> (you)</span>}</strong>{member.title && <small>{member.title}</small>}{isManager(member) && <Badge>Channel manager</Badge>}</div></button>
                {can('remove') && !archived && member.id !== viewer && <button className="space-channel-link" aria-label={`Remove ${member.name} from channel`} onClick={() => setConfirmation(member)}>Remove</button>}
              </li>)}
            </ul>
            {!filtered.length && <p className="space-channel-muted">No members match “{query}”.</p>}
          </>}
          {tab === 'settings' && <>
            <div className="space-channel-card">
              {policy && <><section><div className="space-channel-field-heading"><h3>Posting permissions</h3>{can('manage') && !archived && <button className="space-channel-link" aria-label="Edit posting permissions" onClick={() => setPermissionEditor({ section: 'posting', snapshot: policy })}>Edit</button>}</div><p>{postingLabels[policy.posting]}</p><p className="space-channel-muted">{policy.allow_replies ? 'Threads are allowed.' : 'Only people who can post can reply.'} {policy.allow_broadcast ? 'Channel-wide mentions are allowed, subject to workspace settings.' : 'Channel-wide mentions are disabled.'}</p></section>
              <section><div className="space-channel-field-heading"><h3>Member permissions</h3>{can('manage') && !archived && <button className="space-channel-link" aria-label="Edit member permissions" onClick={() => setPermissionEditor({ section: 'actions', snapshot: policy })}>Edit</button>}</div><p>Choose who can invite and remove people, edit details, or archive this channel.</p></section></>}
              <section><h3>Channel visibility</h3><p>{details.private ? 'Only invited members can find this channel and read its messages.' : 'Everyone in this workspace can find and join this channel.'}</p></section>
              <section><h3>{archived ? 'Archived channel' : 'Archive channel'}</h3><p>{archived ? 'Message history is preserved. Restore this channel to send messages again.' : 'Archive this channel when it’s no longer needed. Its history will remain available to members.'}</p>{can('archive') && <Button onClick={() => setConfirmation('archive')}><Archive size={16} />{archived ? 'Restore channel' : 'Archive channel for everyone'}</Button>}</section></div>
            {permissionsPending && <p className="space-channel-muted" role="status">Checking channel permissions…</p>}
          </>}
        </div>}
      </div>
    </Dialog>
    {permissionEditor && <ChannelPermissionEditor channel={channel.id} snapshot={permissionEditor.snapshot} members={members} section={permissionEditor.section} canEdit={can('manage') && !archived} onClose={() => setPermissionEditor(undefined)} onSaved={next => { setDetails(current => current ? { ...current, permissions: next } : current); }} />}
    {field && details && <ChannelEditor field={field} details={details} onClose={() => setField(undefined)} onSaved={saved} />}
    {adding && details && <AddPeople details={details} members={members} onClose={() => setAdding(false)} onAdded={async () => { const detail = await refresh(); onChange(detail); }} />}
    {confirmation && <ChannelConfirmation
      title={confirmation === 'leave' ? `Leave #${current.name}?` : confirmation === 'archive' ? `${archived ? 'Restore' : 'Archive'} #${current.name}?` : `Remove ${confirmation.name}?`}
      description={confirmation === 'leave' ? current.private ? 'You will need another member to invite you back to this private channel.' : 'You can rejoin this public channel at any time.' : confirmation === 'archive' ? archived ? 'Members will be able to send messages and replies again.' : 'Members can still read message history. New messages and replies will be disabled until this channel is restored.' : `${confirmation.name} will lose access to this channel. ${current.private ? 'They will need an invitation to return.' : 'They can rejoin this public channel.'}`}
      label={confirmation === 'leave' ? 'Leave channel' : confirmation === 'archive' ? archived ? 'Restore channel' : 'Archive channel' : 'Remove member'}
      onClose={() => setConfirmation(undefined)}
      onConfirm={async () => {
        if (confirmation === 'archive') saved(await request<Details>(`/channels/${channel.id}`, { archived: !archived }, undefined, 'PATCH'));
        else {
          await request(`/channels/${channel.id}/members/${confirmation === 'leave' ? viewer : confirmation.id}`, undefined, undefined, 'DELETE');
          if (confirmation !== 'leave') { const detail = await refresh(); onChange(detail); }
        }
      }} onDone={confirmation === 'leave' ? onLeft : undefined} />}
  </>;
}
function MemberAvatar({ member }: { member: ChannelMember }) {
  return member.image ? <img className="space-channel-avatar" src={member.image} alt={member.name} /> : <Avatar name={member.name} initials={member.name.slice(0, 2).toUpperCase()} size="md" presence={member.presence === 'active' ? 'online' : 'away'} />;
}
function ChannelEditor({ field, details, onClose, onSaved }: { field: Field; details: Details; onClose: () => void; onSaved: (detail: Details) => void }) {
  const [value, setValue] = useState(details[field]), [open, setOpen] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const title = field === 'name' ? 'Rename this channel' : field === 'topic' ? 'Edit topic' : 'Edit description';
  const max = field === 'name' ? 80 : field === 'topic' ? 250 : 2000;
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>('input,textarea')?.focus(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { const detail = await request<Details>(`/channels/${details.id}`, { [field]: value }, undefined, 'PATCH'); onSaved(detail); setOpen(false); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Dialog open={open} title={title} onBeforeClose={() => !busy} onClose={onClose}><form ref={form} className="space-channel-editor" onSubmit={save}>
    <label>{field === 'name' ? 'Channel name' : field === 'topic' ? 'Topic' : 'Description'}{field === 'name' ? <input autoFocus required maxLength={max} value={value} onChange={e => setValue(e.target.value)} /> : <textarea autoFocus rows={field === 'topic' ? 3 : 5} maxLength={max} value={value} onChange={e => setValue(e.target.value)} />}</label>
    <div className="space-channel-editor-hint"><span>{field === 'name' ? 'Choose a clear name for your channel.' : field === 'topic' ? `Let people know what #${details.name} is focused on right now. Topics are visible in the header.` : 'Let people know what this channel is for.'}</span><span>{max - value.length}</span></div>
    {error && <p role="alert" className="space-channel-error">{error}</p>}
    <footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" loading={busy} disabled={value.trim() === details[field] || (field === 'name' && !value.trim())}>{field === 'name' ? 'Save Changes' : 'Save'}</Button></footer>
  </form></Dialog>;
}
function AddPeople({ details, members, onClose, onAdded }: { details: Details; members: ChannelMember[]; onClose: () => void; onAdded: () => Promise<void> }) {
  const [people, setPeople] = useState<WorkspaceParticipant[]>([]), [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [open, setOpen] = useState(true), [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>('input[type=search]')?.focus(); }, []);
  useEffect(() => {
    let active = true;
    void listAll<WorkspaceParticipant>(`/workspaces/${details.workspace_id}/participants`).then(items => { if (active) { setPeople(items.filter(p => p.kind === 'human' && !members.some(m => m.id === p.id))); setLoaded(true); } }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [details.workspace_id]);
  async function add(event: FormEvent) {
    event.preventDefault(); if (!selected || busy) return; setBusy(true); setError('');
    try { await request(`/channels/${details.id}/members`, { user_id: selected }); await onAdded(); setOpen(false); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const filtered = people.filter(p => p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Dialog open={open} title={`Add people to #${details.name}`} onBeforeClose={() => !busy} onClose={onClose}><form ref={form} className="space-channel-editor space-channel-picker" onSubmit={add}>
    <label>Find workspace people<input type="search" autoFocus placeholder="Enter a name" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <p className="space-channel-muted">Choose someone from your workspace.</p>
    {!loaded && !error && <p role="status">Loading workspace people…</p>}
    <div className="space-channel-candidates" role="radiogroup" aria-label="Workspace people">{filtered.map(person => <label key={person.id}><input type="radio" aria-label={person.name} name="channel-person" value={person.id} checked={selected === person.id} onChange={() => setSelected(person.id)} /><Avatar name={person.name} initials={person.name.slice(0, 2).toUpperCase()} size="sm" /><strong>{person.name}</strong></label>)}</div>
    {loaded && !filtered.length && <p className="space-channel-muted">{people.length ? 'No people match your search.' : 'Everyone in this workspace is already in the channel.'}</p>}
    {error && <p className="space-channel-error" role="alert">{error}</p>}
    <footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" loading={busy} disabled={!selected}>Add</Button></footer>
  </form></Dialog>;
}
function ChannelConfirmation({ title, description, label, onClose, onConfirm, onDone }: { title: string; description: string; label: string; onClose: () => void; onConfirm: () => Promise<void>; onDone?: () => void }) {
  const [open, setOpen] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  return <Dialog open={open} title={title} onBeforeClose={() => !busy} onClose={() => { onClose(); if (done) onDone?.(); }}><div className="space-channel-editor space-channel-confirm"><p>{description}</p>{error && <p className="space-channel-error" role="alert">{error}</p>}<footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => { if (busy) return; setBusy(true); setError(''); void onConfirm().then(() => { setDone(true); setOpen(false); }).catch(e => setError(errorText(e))).finally(() => setBusy(false)); }}>{label}</Button></footer></div></Dialog>;
}
