import { useMemberProfile } from '../profile/MemberProfile.js';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Avatar, Badge, Button, Dialog, ListRowSkeleton, Skeleton, Tabs, toast } from '@space/ui/primitives';
import { Archive, Copy, Hash, Lock, MagnifyingGlass, UserPlus } from '@phosphor-icons/react';
import type { ChannelDetails as Details, ChannelMember, ChannelSummary, ChannelPermissionSnapshot, WorkspaceParticipant } from '@space/contracts';
import { listAll, request } from '../../shared/api/request.js';
import './channel-details.css';
import { ChannelTabManager } from './ChannelTabs.js';
import { WorkspaceMembers } from '../workspace/members/WorkspaceMembers.js';
import { ChannelAgents, ChannelAgentPicker } from './ChannelAgents.js';
import { ChannelWebhooks } from './ChannelWebhooks.js';
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
  const [agentPicker, setAgentPicker] = useState<'pick' | 'connect'>(), [agentRevision, setAgentRevision] = useState(0);
  const [permissionEditor, setPermissionEditor] = useState<{ section: PermissionSection; snapshot: ChannelPermissionSnapshot }>();
  const id = useId();
  const [details, setDetails] = useState<Details>(), [members, setMembers] = useState<ChannelMember[]>();
  const [detailError, setDetailError] = useState(''), [memberError, setMemberError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState(initialTab), [query, setQuery] = useState(''), [error, setError] = useState('');
  const [field, setField] = useState<Field>(), [adding, setAdding] = useState(false), [copied, setCopied] = useState(false);
  const editRevision = useRef(0);
  const [savingFields, setSavingFields] = useState<Field[]>([]);
  const [confirmation, setConfirmation] = useState<'archive' | 'restore' | 'leave' | ChannelMember>();
  const membershipRevision = useRef(0);
  async function refresh() {
    const revision = ++membershipRevision.current;
    const [detail, people] = await Promise.all([request<Details>(`/channels/${channel.id}`), listAll<ChannelMember>(`/channels/${channel.id}/members`)]);
    if (revision === membershipRevision.current) {
      setDetails(detail); setMembers(people); onChange(detail);
    }
  }
  useEffect(() => {
    let active = true;
    const revision = editRevision.current;
    setDetailError(''); setMemberError('');
    void request<Details>(`/channels/${channel.id}`).then(detail => {
      if (active && revision === editRevision.current) setDetails(detail);
    }).catch(reason => { if (active) setDetailError(errorText(reason)); });
    void listAll<ChannelMember>(`/channels/${channel.id}/members`).then(people => {
      if (active) setMembers(people);
    }).catch(reason => { if (active) setMemberError(errorText(reason)); });
    return () => { active = false; };
  }, [channel.id, attempt]);
  useEffect(() => { setDetails(previous => previous ? { ...previous, ...channel } : previous); }, [channel]);
  function saved(detail: Details) { editRevision.current++; setDetails(detail); onChange(detail); }
  async function saveField(field: Field, value: string) {
    setSavingFields(fields => [...fields, field]);
    try {
      const detail = await request<Details>(`/channels/${channel.id}`, { [field]: value }, undefined, 'PATCH');
      saved(detail);
    } finally {
      setSavingFields(fields => fields.filter(item => item !== field));
    }
  }
  const current = details ?? channel, archived = Boolean(current.archived_at);
  const [savedPolicy, setSavedPolicy] = useState<ChannelPermissionSnapshot>();
  const loaded = !details?.permissions || (savedPolicy && BigInt(savedPolicy.revision) > BigInt(details.permissions.revision))
    ? savedPolicy : details.permissions;
  const policy = permissionsPending ? undefined
    : loaded && (!permissions || BigInt(loaded.revision) > BigInt(permissions.revision)) ? loaded : permissions ?? loaded;
  const can = (action: keyof ChannelPermissionSnapshot['capabilities']) => !permissionsPending && (policy?.capabilities[action] ?? details?.can_manage ?? false);
  const isManager = (member: ChannelMember) => policy ? policy.manager_ids.includes(member.id) : !!member.is_manager;
  const editable = can('edit_details') && !archived;
  const filtered = (members ?? []).filter(member => member.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const memberCount = current.member_count ?? members?.length;
  const loadError = detailError || ((tab === 'members' || (tab === 'about' && policy)) && memberError);
  const actionKey = confirmation && JSON.stringify([viewer, channel.id, typeof confirmation === 'string' ? confirmation : confirmation.id]);
  return <>
    <Dialog open title={`${current.private ? '🔒' : '#'} ${current.name}`} onClose={onClose}>
      <div className="space-channel-details">
        <div className="space-channel-meta"><Badge>{current.private ? 'Private channel' : 'Public channel'}</Badge>{archived && <Badge><Archive size={13} /> Archived</Badge>}{memberCount != null && <span>{memberCount} {memberCount === 1 ? 'member' : 'members'}</span>}</div>
        <Tabs label="Channel details" value={tab} onChange={setTab} items={[{ id: 'about', label: 'About', panelId: `${id}-about` }, { id: 'members', label: `Members${memberCount != null ? ` ${memberCount}` : ''}`, panelId: `${id}-members` }, { id: 'integrations', label: 'Agents & apps', panelId: `${id}-integrations` }, { id: 'tabs', label: 'Tabs', panelId: `${id}-tabs` }, { id: 'settings', label: 'Settings', panelId: `${id}-settings` }]} />
        {loadError && <div className="space-channel-error" role="alert">{loadError} <Button size="sm" onClick={() => setAttempt(n => n + 1)}>Retry</Button></div>}
        {error && <p className="space-channel-error" role="alert">{error}</p>}
        <div key={tab} id={`${id}-${tab}`} role="tabpanel" aria-label={tab === 'tabs' ? 'Tabs' : tab === 'members' ? 'Members' : tab === 'settings' ? 'Settings' : tab === 'integrations' ? 'Agents & apps' : 'About'} className={tab === 'members' ? 'space-channel-body space-channel-body--members' : 'space-channel-body'}>
          {tab === 'tabs' && <ChannelTabManager channel={channel.id} actor={viewer} archived={archived}/>}
          {tab === 'about' && <>
            <div className="space-channel-card">
              {(['name', 'topic', 'description'] as const).map(key => <section key={key} aria-label={key === 'name' ? 'Channel name' : key === 'topic' ? 'Topic' : 'Description'}>
                <div className="space-channel-field-heading"><h3>{key === 'name' ? 'Channel name' : key === 'topic' ? 'Topic' : 'Description'}</h3>{editable && <button className="space-channel-link" aria-label={`Edit channel ${key}`} onClick={() => setField(key)}>Edit</button>}</div>
                <p className={!current[key] ? 'space-channel-muted' : undefined}>{key === 'name' && (current.private ? <Lock size={15} /> : <Hash size={15} />)}{current[key] || (key === 'topic' ? 'Add a topic' : 'Add a description')}</p>
              </section>)}
              {policy && <section><div className="space-channel-field-heading"><h3>Managed by</h3>{can('manage') && !archived && <button className="space-channel-link" disabled={!members} aria-label="Edit channel managers" onClick={() => setPermissionEditor({ section: 'managers', snapshot: policy })}>Edit</button>}</div><p>{members ? members.filter(isManager).map(member => member.name).join(', ') || 'Workspace admins' : !memberError && <Skeleton width={96}/>}</p></section>}
              <section><h3>Created by</h3><p>{details ? <>{details.creator_name ?? 'Workspace'} on {new Date(details.created_at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</> : !detailError && <span role="status"><span className="sp-sr-only">Loading creator…</span><Skeleton width={150}/></span>}</p></section>
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
            {!members && !memberError && <ListRowSkeleton label="Loading members…"/>}
            {members && !filtered.length && <p className="space-channel-muted">No members match “{query}”.</p>}
          </>}
          {tab === 'integrations' && (archived ? <p>This channel is archived.</p> : <>
            <ChannelAgents key={viewer} channel={channel.id} actor={viewer} revision={agentRevision} onAdd={() => setAgentPicker('pick')}/>
            {can('manage') && <WebhookSettings channel={channel.id}/>}
          </>)}
          {tab === 'settings' && <>
            <div className="space-channel-card">
              {policy && <><section><div className="space-channel-field-heading"><h3>Posting permissions</h3>{can('manage') && !archived && <button className="space-channel-link" disabled={!members} aria-label="Edit posting permissions" onClick={() => setPermissionEditor({ section: 'posting', snapshot: policy })}>Edit</button>}</div><p>{postingLabels[policy.posting]}</p><p className="space-channel-muted">{policy.allow_replies ? 'Threads are allowed.' : 'Only people who can post can reply.'} {policy.allow_broadcast ? 'Channel-wide mentions are allowed, subject to workspace settings.' : 'Channel-wide mentions are disabled.'}</p></section>
              <section><div className="space-channel-field-heading"><h3>Member permissions</h3>{can('manage') && !archived && <button className="space-channel-link" aria-label="Edit member permissions" onClick={() => setPermissionEditor({ section: 'actions', snapshot: policy })}>Edit</button>}</div><p>Choose who can invite and remove people, edit details, or archive this channel.</p></section></>}
              <section><h3>Channel visibility</h3><p>{current.private ? 'Only invited members can find this channel and read its messages.' : 'Everyone in this workspace can find and join this channel.'}</p></section>
              <section><h3>{archived ? 'Archived channel' : 'Archive channel'}</h3><p>{archived ? 'Message history is preserved. Restore this channel to send messages again.' : 'Archive this channel when it’s no longer needed. Its history will remain available to members.'}</p>{can('archive') && <Button onClick={() => setConfirmation(archived ? 'restore' : 'archive')}><Archive size={16} />{archived ? 'Restore channel' : 'Archive channel for everyone'}</Button>}</section></div>
            {(permissionsPending || (!policy && !details && !detailError)) && <p className="space-channel-muted" role="status">Checking channel permissions…</p>}
          </>}
        </div>
      </div>
    </Dialog>
    {agentPicker === 'pick' && !archived && <ChannelAgentPicker key={viewer} channel={channel.id} name={current.name} actor={viewer} revision={agentRevision} onConnect={() => setAgentPicker('connect')} onClose={() => setAgentPicker(undefined)} onAdded={() => setAgentRevision(n => n + 1)}/>}
    {agentPicker === 'connect' && !archived && <WorkspaceMembers open workspace={current.workspace_id} viewer={viewer}
      onClose={() => { setAgentRevision(n => n + 1); setAgentPicker('pick'); }} returnOnPaired/>}
    {permissionEditor && <ChannelPermissionEditor channel={channel.id} snapshot={permissionEditor.snapshot} members={members ?? []} section={permissionEditor.section} canEdit={can('manage') && !archived} onClose={() => setPermissionEditor(undefined)} onSaved={next => setSavedPolicy(previous => previous && BigInt(previous.revision) > BigInt(next.revision) ? previous : next)} />}
    {field && <ChannelEditor field={field} details={current} busy={savingFields.includes(field)} canEdit={editable} onClose={() => setField(undefined)} onSave={saveField} />}
    {adding && can('invite') && !archived && <AddPeople details={current} members={members} memberError={memberError} retryMembers={() => setAttempt(n => n + 1)} onClose={() => setAdding(false)} onAdded={refresh} />}
    {confirmation && actionKey && <ChannelConfirmation key={actionKey} actionKey={actionKey}
      pendingLabel={confirmation === 'archive' ? 'Archiving channel…' : confirmation === 'restore' ? 'Restoring channel…' : confirmation === 'leave' ? 'Leaving channel…' : 'Removing member…'}
      title={confirmation === 'leave' ? `Leave #${current.name}?` : confirmation === 'restore' ? `Restore #${current.name}?` : confirmation === 'archive' ? `Archive #${current.name}?` : `Remove ${confirmation.name}?`}
      description={confirmation === 'leave' ? current.private ? 'You will need another member to invite you back to this private channel.' : 'You can rejoin this public channel at any time.' : confirmation === 'restore' ? 'Members will be able to send messages and replies again.' : confirmation === 'archive' ? 'Members can still read message history. New messages and replies will be disabled until this channel is restored.' : `${confirmation.name} will lose access to this channel. ${current.private ? 'They will need an invitation to return.' : 'They can rejoin this public channel.'}`}
      label={confirmation === 'leave' ? 'Leave channel' : confirmation === 'restore' ? 'Restore channel' : confirmation === 'archive' ? 'Archive channel' : 'Remove member'}
      onClose={() => setConfirmation(undefined)}
      onConfirm={async () => {
        if (confirmation === 'archive' || confirmation === 'restore') {
          const detail = await request<Details>(`/channels/${channel.id}`, { archived: confirmation === 'archive' }, undefined, 'PATCH');
          saved(detail);
          return `#${detail.name} ${detail.archived_at ? 'archived' : 'restored'}`;
        }
        await request(`/channels/${channel.id}/members/${confirmation === 'leave' ? viewer : confirmation.id}`, undefined, undefined, 'DELETE');
        if (confirmation === 'leave') { onLeft(); return `You left #${current.name}`; }
        setMembers(previous => previous?.filter(person => person.id !== confirmation.id));
        void refresh().catch(reason => setError(errorText(reason)));
        return `${confirmation.name} removed from #${current.name}`;
      }} />}
  </>;
}
function WebhookSettings({ channel }: { channel: string }) {
  const [open, setOpen] = useState(false);
  return <div className="space-channel-card"><section>
    <div className="space-channel-field-heading"><h3>Incoming webhooks</h3>
      <button className="space-channel-link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Manage'}</button></div>
    <p>Post messages to this channel from an external service.</p>
    {open && <ChannelWebhooks channel={channel}/>}
  </section></div>;
}
function MemberAvatar({ member }: { member: ChannelMember }) {
  return member.image ? <img className="space-channel-avatar" src={member.image} alt={member.name} /> : <Avatar name={member.name} initials={member.name.slice(0, 2).toUpperCase()} size="md" presence={member.presence === 'active' ? 'online' : 'away'} />;
}
function ChannelEditor({ field, details, busy, canEdit, onClose, onSave }: {
  field: Field; details: ChannelSummary; busy: boolean; canEdit: boolean; onClose: () => void;
  onSave: (field: Field, value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(details[field]), [open, setOpen] = useState(true), [error, setError] = useState('');
  const currentValue = useRef(value), dismissed = useRef(false), submitting = useRef(false);
  const title = field === 'name' ? 'Rename this channel' : field === 'topic' ? 'Edit topic' : 'Edit description';
  const max = field === 'name' ? 80 : field === 'topic' ? 250 : 2000;
  const baseline = useRef(details[field]);
  useEffect(() => {
    const savedValue = details[field];
    if (currentValue.current === baseline.current && !submitting.current) {
      currentValue.current = savedValue;
      setValue(savedValue);
    }
    baseline.current = savedValue;
  }, [details, field]);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>('input,textarea')?.focus(); }, []);
  function edit(next: string) {
    currentValue.current = next;
    setValue(next);
    setError('');
  }
  function dismiss() {
    dismissed.current = true;
    setOpen(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || submitting.current || !canEdit || value.trim() === details[field] || (field === 'name' && !value.trim())) return;
    submitting.current = true;
    setError('');
    try {
      await onSave(field, value);
      if (currentValue.current === value) setOpen(false);
    } catch (reason) {
      if (dismissed.current) toast.error(`Couldn’t save the channel ${field}. ${errorText(reason)}`);
      else setError(errorText(reason));
    } finally { submitting.current = false; }
  }
  const progress = `Saving ${field}…`;
  return <Dialog open={open} title={title} onClose={() => { dismissed.current = true; onClose(); }}><form ref={form} className="space-channel-editor" onSubmit={save}>
    <label>{field === 'name' ? 'Channel name' : field === 'topic' ? 'Topic' : 'Description'}{field === 'name' ? <input autoFocus required maxLength={max} value={value} onChange={e => edit(e.target.value)} /> : <textarea autoFocus rows={field === 'topic' ? 3 : 5} maxLength={max} value={value} onChange={e => edit(e.target.value)} />}</label>
    <div className="space-channel-editor-hint"><span>{field === 'name' ? 'Choose a clear name for your channel.' : field === 'topic' ? `Let people know what #${details.name} is focused on right now. Topics are visible in the header.` : 'Let people know what this channel is for.'}</span><span>{max - value.length}</span></div>
    {error && <p role="alert" className="space-channel-error">{error}</p>}
    <footer><Button onClick={dismiss}>{busy ? 'Close' : 'Cancel'}</Button><Button variant="primary" type="submit" loading={busy} disabled={!canEdit || value.trim() === details[field] || (field === 'name' && !value.trim())}>{busy ? progress : field === 'name' ? 'Save Changes' : 'Save'}</Button></footer>
    <span className="sp-sr-only" role="status">{busy && progress}</span>
  </form></Dialog>;
}
function AddPeople({ details, members, memberError, retryMembers, onClose, onAdded }: { details: ChannelSummary; members?: ChannelMember[]; memberError: string; retryMembers: () => void; onClose: () => void; onAdded: () => Promise<void> }) {
  const [people, setPeople] = useState<WorkspaceParticipant[]>();
  const [peopleError, setPeopleError] = useState(''), [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [open, setOpen] = useState(true), [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>('input[type=search]')?.focus(); }, []);
  useEffect(() => {
    let active = true;
    setPeopleError('');
    void listAll<WorkspaceParticipant>(`/workspaces/${details.workspace_id}/participants`)
      .then(items => { if (active) setPeople(items); })
      .catch(e => { if (active) setPeopleError(errorText(e)); });
    return () => { active = false; };
  }, [details.workspace_id, attempt]);
  async function add(event: FormEvent) {
    event.preventDefault(); if (!canAdd || busy) return; setBusy(true); setError('');
    try { await request(`/channels/${details.id}/members`, { user_id: selected }); await onAdded(); setOpen(false); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const memberIds = new Set(members?.map(member => member.id));
  const candidates = members && people?.filter(person => person.kind === 'human' && !memberIds.has(person.id));
  const canAdd = candidates?.some(person => person.id === selected);
  const filtered = candidates?.filter(p => p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Dialog open={open} title={`Add people to #${details.name}`} onBeforeClose={() => !busy} onClose={onClose}><form ref={form} className="space-channel-editor space-channel-picker" onSubmit={add}>
    <label>Find workspace people<input type="search" autoFocus placeholder="Enter a name" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <p className="space-channel-muted">Choose someone from your workspace.</p>
    {!candidates && !peopleError && !memberError && <ListRowSkeleton label="Loading workspace people…"/>}
    {peopleError && <p role="alert">{peopleError} <Button onClick={() => setAttempt(n => n + 1)}>Retry</Button></p>}
    {memberError && <p role="alert">{memberError} <Button onClick={retryMembers}>Retry</Button></p>}
    <div className="space-channel-candidates" role="radiogroup" aria-label="Workspace people">{filtered?.map(person => <label key={person.id}><input type="radio" aria-label={person.name} name="channel-person" value={person.id} checked={selected === person.id} onChange={() => setSelected(person.id)} /><Avatar name={person.name} initials={person.name.slice(0, 2).toUpperCase()} size="sm" /><strong>{person.name}</strong></label>)}</div>
    {filtered && !filtered.length && <p className="space-channel-muted">{candidates?.length ? 'No people match your search.' : 'Everyone in this workspace is already in the channel.'}</p>}
    {error && <p className="space-channel-error" role="alert">{error}</p>}
    <footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" loading={busy} disabled={!canAdd}>Add</Button></footer>
  </form></Dialog>;
}

type ResultListener = (error?: string) => void;
// A submitted mutation can outlive its dialog and be revisited from another entry point.
const pending = new Map<string, Set<ResultListener>>();

export function ChannelConfirmation({ actionKey, title, description, label, pendingLabel, onClose, onConfirm }: {
  actionKey: string; title: string; description: string; label: string; pendingLabel: string;
  onClose: () => void; onConfirm: () => Promise<string>;
}) {
  const [open, setOpen] = useState(true), [busy, setBusy] = useState(() => pending.has(actionKey)), [error, setError] = useState('');
  const finish = useRef<ResultListener>(message => {
    setBusy(false);
    if (message !== undefined) setError(message);
    else setOpen(false);
  }).current;

  useLayoutEffect(() => {
    pending.get(actionKey)?.add(finish);
    return () => { pending.get(actionKey)?.delete(finish); };
  }, [actionKey, finish]);

  function dismiss() {
    pending.get(actionKey)?.delete(finish);
    return true;
  }
  async function confirm() {
    setError('');
    setBusy(true);
    const existing = pending.get(actionKey);
    if (existing) { existing.add(finish); return; }
    const listeners = new Set([finish]);
    pending.set(actionKey, listeners);
    try {
      const message = await onConfirm();
      toast.success(message);
      for (const notify of listeners) notify();
    } catch (reason) {
      const message = errorText(reason);
      if (!listeners.size) toast.error(`${title.replace(/\?$/, '')}: ${message}`);
      for (const notify of listeners) notify(message);
    } finally {
      pending.delete(actionKey);
    }
  }
  return <Dialog open={open} title={title} onBeforeClose={dismiss} onClose={onClose}>
    <div className="space-channel-editor space-channel-confirm">
      <p>{description}</p>
      {error && <p className="space-channel-error" role="alert">{error}</p>}
      <footer>
        <Button onClick={() => { dismiss(); setOpen(false); }}>{busy ? 'Close' : 'Cancel'}</Button>
        <Button variant="primary" loading={busy} onClick={() => void confirm()}>{busy ? pendingLabel : label}</Button>
      </footer>
      <span className="sp-sr-only" role="status">{busy && pendingLabel}</span>
    </div>
  </Dialog>;
}
