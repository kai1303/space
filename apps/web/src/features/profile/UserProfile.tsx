import { useMemberProfile } from './MemberProfile.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import { Select, Avatar, Button, Dialog, IconButton, Popover, SidePanel, Spinner, TextField } from '@space/ui/primitives';
import { EmojiPicker } from '@space/ui/emoji';
import { Clock, EnvelopeSimple, Phone, Plus, Smiley, X } from '@phosphor-icons/react';
import { workspacePath, visibleStatus, type ProfileUpdate, type UserProfile, type UserStatus } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { SignOutButton } from '../auth/AuthScreen.js';
import { Connections } from '../connections/Connections.js';
import { AccountNotificationMenu } from '../notifications/AccountNotificationMenu.js';
import { NotificationPreferences } from '../notifications/Notifications.js';
import './profile.css';

const errorText = (e: unknown) => e instanceof Error ? e.message.replaceAll('_', ' ') : 'Could not save. Please try again.';
const presets = [
  { text: 'In a meeting', emoji: '🗓️', duration: '60', hint: '1 hour' },
  { text: 'Commuting', emoji: '🚌', duration: '30', hint: '30 minutes' },
  { text: 'Out sick', emoji: '🤒', duration: 'today', hint: 'Today' },
  { text: 'Vacationing', emoji: '🌴', duration: 'never', hint: 'Don’t clear' },
  { text: 'Working remotely', emoji: '🏡', duration: 'today', hint: 'Today' },
];


type UserSettingsProps = { onOpenVault?: () => void; workspace?: string; user: string; userId?: string; onNameChange?: (name: string) => void };
export function UserSettings(props: UserSettingsProps) {
  return <AccountSettings key={props.userId} {...props}/>;
}
function AccountSettings({ user, userId, workspace, onNameChange, onOpenVault }: UserSettingsProps) {
  const profiles = useMemberProfile();
  useEffect(() => { if (profiles?.selected) setPanel(false); }, [profiles?.selected]);
  const [profile, setProfile] = useState<UserProfile>({ id: userId ?? '', display_name: user, full_name: '', title: '', name_pronunciation: '', phone: '', time_zone: 'UTC', image: null, email: null, status: null, presence: 'active' });
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(false), [editor, setEditor] = useState<'profile' | 'status' | null>(null);
  const [preferences, setPreferences] = useState(false);
  const [connections, setConnections] = useState(false);
  const [, tick] = useState(0);
  const alive = useRef(true), root = useRef<HTMLDivElement>(null), closePanelButton = useRef<HTMLButtonElement>(null);
  async function load() {
    setError(''); setLoading(true);
    try {
      const value = await request<UserProfile>('/me');
      if (alive.current && value.id && (!userId || value.id === userId)) { setProfile(old => ({ ...old, ...value })); setLoaded(true); onNameChange?.(value.display_name); }
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [userId]);
  const status = visibleStatus(profile.status);
  useEffect(() => {
    if (!status?.expires_at) return;
    // Refresh from wall-clock time, including after a suspended tab resumes.
    const timer = window.setInterval(() => tick(n => n + 1), 1000);
    const resume = () => tick(n => n + 1);
    document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', resume); };
  }, [status?.expires_at]);
  function closePanel() { setPanel(false); root.current?.querySelector<HTMLElement>('summary')?.focus(); }
  useEffect(() => {
    if (panel && !editor) closePanelButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'y') { event.preventDefault(); if (loaded && !busy) setEditor('status'); }
      if (event.key === 'Escape' && panel && !editor) closePanel();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [panel, editor, loaded, busy]);
  async function save(change: ProfileUpdate) {
    setBusy(true); setError('');
    try {
      const value = await request<UserProfile>('/me', change, undefined, 'PATCH');
      if (alive.current) { setProfile(value); onNameChange?.(value.display_name); }
    } catch (e) { if (alive.current) setError(errorText(e)); throw e; }
    finally { if (alive.current) setBusy(false); }
  }
  function open(next: 'profile' | 'status') { setError(''); if (next === 'profile') { profiles?.close(); setPanel(true); } else setEditor('status'); }
  const profilePending = loading
    ? <p role="status" className="space-account-loading"><Spinner/>Loading profile…</p>
    : <Button size="sm" onClick={() => void load()}>Reload profile</Button>;
  return <div className={`space-user-settings ${panel ? 'is-profile-open' : ''}`} ref={root}>
    <Popover label="Your account" panelLabel="Your account" role="menu" floating align="start" className="space-account-menu" panelClassName="space-account-popover" trigger={<ProfilePhoto profile={profile} small showPresence={loaded} />}>
      {close => <>
        <div className="space-account-heading"><ProfilePhoto profile={profile} small showPresence={loaded} /><div><strong>{loaded ? profile.display_name : user}</strong>{loaded && <span><Presence value={profile.presence} /> {profile.presence === 'away' ? 'Away' : 'Active'}</span>}</div></div>
        {!loaded ? profilePending : <>
          <button role="menuitem" className="space-account-status" onClick={() => { close(); open('status'); }}><span aria-hidden="true">{status?.emoji || <Smiley size={20} />}</span><span>{status?.text || 'Update your status'}</span></button>
          {status && <button role="menuitem" disabled={busy} onClick={() => { close(); void save({ status: null }).catch(() => {}); }}>Clear status</button>}
          <button role="menuitem" disabled={busy} onClick={() => { close(); void save({ presence: profile.presence === 'active' ? 'away' : 'active' }).catch(() => {}); }}>Set yourself as {profile.presence === 'active' ? 'away' : 'active'}</button>
        </>}
          {workspace && profile.id && <AccountNotificationMenu workspace={workspace} actor={profile.id} onClose={close}/>}
          <hr /><button role="menuitem" onClick={() => { close(); open('profile'); }}>Profile</button>
          <a role="menuitem" href={workspace && workspacePath(workspace).startsWith('/w/') ? workspacePath(workspace) + '/vault' : '/vault'} onClick={event => {
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            close();
            if (onOpenVault) { event.preventDefault(); onOpenVault(); }
          }}>Vault</a>
          {workspace && <button role="menuitem" onClick={() => { close(); setPreferences(true); }}>Preferences</button>}
          {(userId || loaded) && <button role="menuitem" onClick={() => { close(); setConnections(true); }}>Connections</button>}
        <hr /><SignOutButton role="menuitem" />
      </>}
    </Popover>
    {error && !panel && !editor && <div role="alert" className="space-profile-notice">{error}<button aria-label="Dismiss profile error" onClick={() => setError('')}><X size={16} /></button></div>}
    {createPortal(<AnimatePresence>{panel && <SidePanel key="profile" className="space-profile-panel" role="dialog" aria-label="Your profile">
      <header><strong>Profile</strong><button ref={closePanelButton} aria-label="Close profile" onClick={closePanel}><X size={20} /></button></header>
      <div className="space-profile-scroll">
        {!loaded ? <><h2>{user}</h2>{profilePending}</> : <>
        <div className="space-profile-portrait"><ProfilePhoto profile={profile} /><Button size="sm" onClick={() => setEditor('profile')}>Edit photo</Button></div>
        <section><div className="space-profile-name"><h2>{profile.full_name || profile.display_name}</h2><button className="space-profile-link" aria-label="Edit profile" onClick={() => setEditor('profile')}>Edit</button></div>
          {profile.full_name && profile.full_name !== profile.display_name && <p className="space-profile-secondary">{profile.display_name}</p>}
          {profile.title && <p>{profile.title}</p>}
          {profile.name_pronunciation && <p className="space-profile-secondary">{profile.name_pronunciation}</p>}
          <p className="space-profile-row"><Presence value={profile.presence} />{profile.presence === 'away' ? 'Away' : 'Active'}</p>
          {status && <p className="space-profile-row"><span>{status.emoji}</span>{status.text}</p>}
          <p className="space-profile-row"><Clock size={20} />{new Intl.DateTimeFormat(undefined, { timeZone: profile.time_zone, hour: 'numeric', minute: '2-digit' }).format(new Date())} local time</p>
          <Button onClick={() => setEditor('status')}>{status ? 'Edit status' : 'Set a status'}</Button>
        </section>
        <section><div className="space-profile-section-heading"><h3>Contact information</h3><button className="space-profile-link" aria-label="Edit contact information" onClick={() => setEditor('profile')}>Edit</button></div>
          {profile.email && <div className="space-profile-row"><EnvelopeSimple size={20} /><div><small>Email address</small><a href={`mailto:${profile.email}`}>{profile.email}</a></div></div>}
          {profile.phone ? <div className="space-profile-row"><Phone size={20} /><div><small>Phone</small><span>{profile.phone}</span></div></div> : <button className="space-profile-link space-profile-add" onClick={() => setEditor('profile')}><Plus size={16} />Add phone</button>}
        </section>
        </>}
        {error && !editor && <p role="alert" className="space-profile-error">{error}</p>}
      </div>
    </SidePanel>}</AnimatePresence>, document.body)}
    {editor === 'profile' && <ProfileEditor profile={profile} busy={busy} error={error} save={save} onClose={() => setEditor(null)} />}
    {editor === 'status' && <StatusEditor profile={{ ...profile, status }} busy={busy} error={error} save={save} onClose={() => setEditor(null)} />}
    {preferences && workspace && <NotificationPreferences key={workspace} title="Preferences" workspace={workspace} onClose={() => setPreferences(false)}/>}
    {connections && <Connections onOpenVault={onOpenVault} key={userId ?? profile.id} userId={userId ?? profile.id} onClose={() => setConnections(false)} />}
  </div>;
}

function Presence({ value }: { value: UserProfile['presence'] }) { return <span className={`space-profile-presence ${value === 'away' ? 'is-away' : ''}`} aria-hidden="true" />; }
function ProfilePhoto({ profile, small = false, showPresence = true }: { profile: UserProfile; small?: boolean; showPresence?: boolean }) {
  return <span className={`space-profile-photo ${small ? 'is-small' : ''}`}>
    {profile.image ? <img src={profile.image} alt={small ? profile.display_name : `Profile photo for ${profile.display_name}`} /> : <Avatar name={profile.display_name} initials={profile.display_name.slice(0, 2).toUpperCase()} tone="blue" size={small ? 'sm' : 'lg'} />}
    {small && showPresence && <Presence value={profile.presence} />}
  </span>;
}

function ProfileEditor({ profile, busy, error, save, onClose }: { profile: UserProfile; busy: boolean; error: string; save: (change: ProfileUpdate) => Promise<void>; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState(profile), [photoError, setPhotoError] = useState(''), [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function photo(file?: File) {
    if (!file) return;
    setPhotoError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { setPhotoError('Choose a JPG, PNG, or WebP image smaller than 5 MB.'); return; }
    setReading(true);
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 192;
        const context = canvas.getContext('2d'); if (!context) throw new Error('Photo editing is unavailable. Try another browser.');
        const size = Math.min(bitmap.width, bitmap.height);
        context.fillStyle = '#fff'; context.fillRect(0, 0, 192, 192);
        context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 192, 192);
        const image = canvas.toDataURL('image/jpeg', .85);
        if (image.length > 200_000) throw new Error('This photo is too large. Choose a smaller image.');
        if (alive.current) setDraft(old => ({ ...old, image }));
      } finally { bitmap.close(); }
    } catch (e) { if (alive.current) setPhotoError(errorText(e)); }
    finally { if (alive.current) setReading(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const { full_name, display_name, title, name_pronunciation, phone, time_zone, image } = draft;
    try { await save({ full_name, display_name, title, name_pronunciation, phone, time_zone, image }); if (alive.current) setOpen(false); } catch {}
  }
  const zones = [...new Set([profile.time_zone, Intl.DateTimeFormat().resolvedOptions().timeZone, ...Intl.supportedValuesOf('timeZone')])];
  return <Dialog open={open} title="Edit your profile" onClose={onClose} onBeforeClose={() => !busy}>
    <form className="space-profile-editor" onSubmit={submit}>
      <fieldset disabled={busy}>
        <div className="space-profile-columns"><div>
          <TextField label="Full name" maxLength={200} value={draft.full_name} onChange={e => setDraft({ ...draft, full_name: e.target.value })} />
          <TextField label="Display name" required maxLength={100} hint="This could be your first name, or a nickname — however you’d like people to refer to you in Space." value={draft.display_name} onChange={e => setDraft({ ...draft, display_name: e.target.value })} />
          <TextField label="Title" maxLength={200} hint="Let people know what you do." value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
        </div><div className="space-profile-photo-edit"><strong>Profile photo</strong><ProfilePhoto profile={draft} /><input ref={input} aria-label="Upload profile photo" type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => { void photo(e.target.files?.[0]); e.target.value = ''; }} />
          <Button disabled={reading} onClick={() => input.current?.click()}>{reading ? 'Preparing photo…' : 'Upload Photo'}</Button>
          {draft.image && <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, image: null })}>Remove photo</Button>}
          <small>JPG, PNG, or WebP. Up to 5 MB.</small>
        </div></div>
        <TextField label="Name pronunciation" maxLength={200} placeholder="e.g. Kai (pronounced ‘k-eye’)" value={draft.name_pronunciation} onChange={e => setDraft({ ...draft, name_pronunciation: e.target.value })} />
        <TextField label="Phone" type="tel" maxLength={50} value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} />
        <label className="space-profile-select">Time zone<Select searchable aria-label="Time zone" value={draft.time_zone} onChange={e => setDraft({ ...draft, time_zone: e.target.value })}>{zones.map(zone => <option key={zone}>{zone}</option>)}</Select><small>Your local time is shown on your profile.</small></label>
      </fieldset>
      {(error || photoError) && <p role="alert" className="space-profile-error">{photoError || error}</p>}
      <footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={reading || !draft.display_name.trim()}>Save Changes</Button></footer>
    </form>
  </Dialog>;
}

function StatusEditor({ profile, busy, error, save, onClose }: { profile: UserProfile; busy: boolean; error: string; save: (change: ProfileUpdate) => Promise<void>; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const [initialExpiration] = useState(profile.status?.expires_at ?? null);
  const [text, setText] = useState(profile.status?.text ?? ''), [emoji, setEmoji] = useState(profile.status?.emoji ?? '');
  const [duration, setDuration] = useState(profile.status?.expires_at ? 'existing' : 'never'), [date, setDate] = useState(''), [localError, setLocalError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setLocalError('');
    let expires_at: string | null = null;
    if (duration === 'existing') {
      if (!initialExpiration || Date.parse(initialExpiration) <= Date.now()) { setLocalError('This status has expired. Choose a new duration.'); return; }
      expires_at = initialExpiration;
    }
    else if (duration === 'custom') {
      const time = Date.parse(date); if (!Number.isFinite(time) || time <= Date.now()) { setLocalError('Choose a date and time in the future.'); return; }
      expires_at = new Date(time).toISOString();
    } else if (duration === 'today') expires_at = endOfDay(profile.time_zone).toISOString();
    else if (duration !== 'never') expires_at = new Date(Date.now() + Number(duration) * 60_000).toISOString();
    const status: UserStatus | null = text.trim() || emoji ? { text: text.trim(), emoji, expires_at } : null;
    try { await save({ status }); setOpen(false); } catch {}
  }
  return <Dialog open={open} title="Set a status" onClose={onClose} onBeforeClose={() => !busy}>
    <form className="space-status-editor" onSubmit={submit}>
      <fieldset disabled={busy}>
        <div className="space-status-input"><EmojiPicker label="Choose status emoji" className="space-status-emoji" trigger={<span>{emoji || <Smiley size={24} />}</span>} onSelect={setEmoji} />{emoji && <IconButton label="Remove status emoji" onClick={() => setEmoji('')}><X size={16} /></IconButton>}<input aria-label="Status" placeholder="What’s your status?" maxLength={100} value={text} onChange={e => setText(e.target.value)} />{(text || emoji) && <IconButton label="Clear all" onClick={() => { setText(''); setEmoji(''); }}><X size={18} /></IconButton>}</div>
        {!text && !emoji ? <div className="space-status-presets"><strong>Suggestions</strong>{presets.map(preset => <button key={preset.text} type="button" onClick={() => { setText(preset.text); setEmoji(preset.emoji); setDuration(preset.duration); }}><span>{preset.emoji}</span><span>{preset.text}</span><small>— {preset.hint}</small></button>)}</div> : <label className="space-profile-select">Duration<Select aria-label="Duration" value={duration} onChange={e => setDuration(e.target.value)}>
          {initialExpiration && <option value="existing">Keep current expiration</option>}
          <option value="never">Don’t clear</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="today">Today</option><option value="custom">Choose a date and time…</option>
        </Select></label>}
        {duration === 'custom' && <TextField label="Clear status at" type="datetime-local" required value={date} hint="Uses your browser’s local time zone." onChange={e => setDate(e.target.value)} />}
      </fieldset>
      {(error || localError) && <p role="alert" className="space-profile-error">{localError || error}</p>}
      <footer><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" loading={busy} disabled={!text.trim() && !emoji && !profile.status}>Save</Button></footer>
      <p className="space-status-shortcut">Tip: Open this faster with <kbd>⌘ / Ctrl + Shift + Y</kbd></p>
    </form>
  </Dialog>;
}

// Convert midnight in the profile time zone, including a DST offset change.
export function endOfDay(zone: string, now = new Date()): Date {
  const parts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const p = parts(now), target = Date.UTC(p.year!, p.month! - 1, p.day! + 1);
  let instant = target;
  for (let i = 0; i < 3; i++) { const q = parts(new Date(instant)); const offset = Date.UTC(q.year!, q.month! - 1, q.day!, q.hour!, q.minute!, q.second!) - instant; instant = target - offset; }
  return new Date(instant);
}
