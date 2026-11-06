import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { Avatar, Badge, Button, Menu, SidePanel } from '@space/ui/primitives';
import { ChatCircle, Clock, DotsThree, EnvelopeSimple, Phone, X } from '@phosphor-icons/react';
import { visibleStatus, type DirectMessageSummary, type WorkspaceProfile } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import './profile.css';
import './member-profile.css';

export type ProfileTarget = { kind: 'user' | 'agent'; id: string };
type ProfileContext = { open: (target: ProfileTarget) => void; close: () => void; selected?: ProfileTarget };
const Context = createContext<ProfileContext | null>(null);
export const useMemberProfile = () => useContext(Context);
const failure = (error: unknown) => error instanceof Error ? error.message.replaceAll('_', ' ') : 'Unable to load this profile.';

export function ProfileProvider({ children, workspace, viewer, onMessage, onConnection }: {
  children: ReactNode; workspace: string; viewer: string;
  onMessage: (profile: WorkspaceProfile, channel: string) => void;
  onConnection: (id: string) => void;
}) {
  const [selection, setSelection] = useState<{workspace: string; target: ProfileTarget} | undefined>(() => {
    const params = new URLSearchParams(window.location.search), value = params.get('profile');
    const match = value?.match(/^(user|agent):([0-9a-f-]{36})$/i);
    return params.get('workspace') === workspace && match ? {workspace, target:{kind:match[1] as ProfileTarget['kind'], id:match[2]!}} : undefined;
  });
  const trigger = useRef<HTMLElement | null>(null);
  const selected = selection?.workspace === workspace ? selection.target : undefined;
  const open = useCallback((target: ProfileTarget) => {
    const element = document.activeElement;
    if (element instanceof HTMLElement && !element.closest('.space-member-profile')) trigger.current = element;
    setSelection({workspace, target});
  }, [workspace]);
  const close = useCallback(() => {
    setSelection(undefined);
    const element = trigger.current;
    requestAnimationFrame(() => {
      const target = element?.isConnected && !element.closest('[inert], [hidden]') ? element : document.getElementById('chat-messages');
      target?.focus({preventScroll:true});
    });
  }, []);
  useEffect(() => { setSelection(value => value?.workspace === workspace ? value : undefined); }, [workspace]);
  return <Context.Provider value={{open, close, selected}}>{children}{createPortal(
    <AnimatePresence>{selected && <ProfilePanel key={`${workspace}:${selected.kind}:${selected.id}`} workspace={workspace} viewer={viewer} target={selected} onClose={close} onMessage={onMessage} onConnection={onConnection}/>}</AnimatePresence>, document.body
  )}</Context.Provider>;
}

function ProfilePanel({workspace, viewer, target, onClose, onMessage, onConnection}: {
  workspace: string; viewer: string; target: ProfileTarget; onClose: () => void;
  onMessage: (profile: WorkspaceProfile, channel: string) => void; onConnection: (id: string) => void;
}) {
  const present = useIsPresent(), presentRef = useRef(present);
  presentRef.current = present;
  const [profile, setProfile] = useState<WorkspaceProfile>(), [error, setError] = useState(''), [actionError, setActionError] = useState('');
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [copied, setCopied] = useState('');
  const panel = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(true), allowed = useRef(true), messaging = useRef(false), action = useRef<AbortController | undefined>(undefined);
  useLayoutEffect(() => { closeButton.current?.focus({preventScroll:true}); }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; action.current?.abort(); };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!presentRef.current || event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      // Menus consume Escape before it reaches the profile.
      if (document.querySelector('[role="menu"]')) return;
      event.preventDefault(); onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    if (!present) { allowed.current = false; action.current?.abort(); return; }
    let active = true, revision = 0;
    let controller: AbortController | undefined;
    allowed.current = true;
    const read = async () => {
      const version = ++revision; controller?.abort(); controller = new AbortController();
      try {
        const value = await request<WorkspaceProfile>(`/workspaces/${workspace}/profiles/${target.kind}/${target.id}`, undefined, undefined, 'POST', controller.signal);
        if (active && presentRef.current && version === revision) {
          if (value.id !== target.id || value.kind !== target.kind) throw new Error('Invalid profile response');
          allowed.current = true; setProfile(value); setError('');
        }
      } catch (reason) {
        if (active && version === revision && !(reason instanceof Error && reason.name === 'AbortError')) {
          allowed.current = false; action.current?.abort(); setBusy(false); setProfile(undefined); setError(failure(reason));
        }
      }
    };
    const stop = subscribeUpdates('workspace', workspace, read, code => {
      active = false; revision++; controller?.abort(); action.current?.abort(); allowed.current = false;
      setProfile(undefined); setBusy(false); setError(code === 'not_found' || code === 'forbidden' ? 'This profile is no longer available.' : failure(new Error(code)));
    });
    return () => { active = false; revision++; controller?.abort(); action.current?.abort(); stop(); };
  }, [workspace, target.kind, target.id, attempt, present]);
  async function message() {
    if (!profile || !allowed.current || messaging.current) return;
    messaging.current = true; setBusy(true); setActionError('');
    const controller = new AbortController(); action.current = controller;
    try {
      const dm = await request<DirectMessageSummary>(`/workspaces/${workspace}/direct-messages`, {user_id: profile.kind === 'user' ? profile.id : viewer}, undefined, 'POST', controller.signal);
      if (alive.current && presentRef.current && allowed.current && !controller.signal.aborted) onMessage(profile, dm.id);
    } catch (reason) {
      if (alive.current && !controller.signal.aborted) setActionError(failure(reason));
    } finally { messaging.current = false; if (alive.current) setBusy(false); }
  }
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); if (alive.current) {setCopied(label); setActionError('');} }
    catch { if (alive.current) setActionError('Could not copy. Please try again.'); }
  }
  const link = new URL('/chat', window.location.origin);
  link.searchParams.set('workspace', workspace); link.searchParams.set('profile', `${target.kind}:${target.id}`);
  const status = profile?.kind === 'user' ? visibleStatus(profile.status) : null;
  return <SidePanel ref={panel} className="space-profile-panel space-member-profile" role="region" aria-label="Profile">
    <header><strong>Profile</strong><button ref={closeButton} type="button" aria-label="Close profile" onClick={onClose}><X size={20}/></button></header>
    <div className="space-profile-scroll">
      {error ? <div className="space-member-profile-notice"><p role="alert">{error}</p><Button onClick={() => {setError(''); setAttempt(value => value + 1);}}>Retry</Button></div> : !profile ? <p className="space-member-profile-notice" role="status">Loading profile…</p> : <>
        <div className="space-profile-portrait"><span className="space-profile-photo"><Avatar name={profile.display_name} initials={profile.display_name.slice(0,2).toUpperCase()} image={profile.image} size="lg" tone={profile.kind === 'agent' ? 'green' : 'blue'}/></span></div>
        <section>
          <div className="space-profile-name"><h2>{profile.kind === 'user' ? profile.full_name || profile.display_name : profile.display_name}</h2>{profile.kind === 'agent' && <Badge>Agent</Badge>}</div>
          {profile.kind === 'user' ? <>
            {profile.full_name && profile.full_name !== profile.display_name && <p className="space-profile-secondary">{profile.display_name}</p>}
            {profile.title && <p>{profile.title}</p>}{profile.name_pronunciation && <p className="space-profile-secondary">{profile.name_pronunciation}</p>}
            <p className="space-profile-row"><span className={`space-profile-presence${profile.presence === 'away' ? ' is-away' : ''}`} aria-hidden="true"/>{profile.presence === 'away' ? 'Away' : 'Active'}</p>
            {status && <p>{status.emoji} {status.text}</p>}
            <p className="space-profile-row"><Clock size={20}/>{new Intl.DateTimeFormat(undefined,{timeZone:profile.time_zone,hour:'numeric',minute:'2-digit'}).format(new Date())} local time</p>
          </> : <p className="space-profile-row"><span className={`space-profile-presence${profile.availability !== 'online' || !profile.enabled ? ' is-away' : ''}`} aria-hidden="true"/>{!profile.enabled ? 'Disabled' : ({online:'Online',offline:'Offline',auth_required:'Sign-in required',error:'Connection needs attention',unknown:'Status unavailable'})[profile.availability]}</p>}
          <div className="space-member-profile-actions">
            {(profile.kind === 'user' || profile.can_message) && <Button aria-label={`Message ${profile.display_name}`} loading={busy} onClick={() => void message()}><ChatCircle size={18}/>Message</Button>}
            <Menu label="More profile actions" floating trigger={<DotsThree size={22} weight="bold"/>} items={[
              {label:`Copy display name: @${profile.display_name}`,onSelect:()=>void copy(`@${profile.display_name}`,'Display name copied')},
              {label:profile.kind === 'agent' ? 'Copy agent ID' : 'Copy member ID',onSelect:()=>void copy(profile.id,'ID copied')},
              {label:'Copy link to profile',onSelect:()=>void copy(link.href,'Profile link copied')},
            ]}/>
          </div>
          {copied && <p role="status" className="space-profile-secondary">{copied}</p>}
          {actionError && <p role="alert">{actionError}</p>}
        </section>
        {profile.kind === 'user' && (profile.email || profile.phone) && <section><div className="space-profile-section-heading"><h3>Contact information</h3></div>
          {profile.email && <div className="space-profile-row"><EnvelopeSimple size={20}/><div><small>Email address</small><a href={`mailto:${profile.email}`}>{profile.email}</a></div></div>}
          {profile.phone && <div className="space-profile-row"><Phone size={20}/><div><small>Phone</small><a href={`tel:${profile.phone}`}>{profile.phone}</a></div></div>}
        </section>}
        {profile.kind === 'agent' && <section><div className="space-profile-section-heading"><h3>About this agent</h3></div><p>Connected by {profile.owner_name}</p>
          {!profile.can_message && <p className="space-profile-secondary">Mention this agent in a shared channel to start a conversation.</p>}
          {profile.owner_id === viewer && <Button onClick={() => onConnection(profile.id)}>View connection</Button>}
        </section>}
      </>}
    </div>
  </SidePanel>;
}
