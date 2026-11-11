import { workspacePath } from '@space/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Avatar, Button, Dialog, Popover } from '@space/ui/primitives';
import { ArrowLeft, Check, MagnifyingGlass, Plus, UserPlus } from '@phosphor-icons/react';
import { AuthScreen } from '../../features/auth/AuthScreen.js';
import './workspace-switcher.css';

export type WorkspaceChoice = { id: string; name: string; icon_url?: string | null };
const initials = (name: string) => {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words.slice(0, 2).map(word => word[0]).join('') : name.trim().slice(0, 2)).toUpperCase() || 'W';
};
export const workspaceAddress = (id: string) => `${window.location.host}${workspacePath(id)}`;

export function WorkspaceIcon({ workspace, className = 'workspace-switcher-icon' }: { workspace: Pick<WorkspaceChoice, 'name' | 'icon_url'>; className?: string }) {
  return <span className={`${className} workspace-logo`} aria-hidden="true"><Avatar name={workspace.name} initials={initials(workspace.name)} image={workspace.icon_url}/></span>;
}

export function WorkspaceSwitcher({ items, value, onChange, onCreate }: {
  items: WorkspaceChoice[]; value: string; onChange: (id: string) => void; onCreate?: (name: string) => Promise<void>;
}) {
  const current = items.find(item => item.id === value);
  const name = current?.name ?? 'Workspace';
  const [mode, setMode] = useState<'add' | 'find' | 'create' | 'sign-in'>();
  const [query, setQuery] = useState(''), [workspaceName, setWorkspaceName] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const trigger = useRef<HTMLDivElement>(null), submitting = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function close() { setMode(undefined); trigger.current?.querySelector('summary')?.focus(); }
  async function create(event: FormEvent) {
    event.preventDefault();
    const trimmed = workspaceName.trim();
    if (!trimmed || submitting.current || !onCreate) return;
    submitting.current = true; setBusy(true); setError('');
    try { await onCreate(trimmed); if (alive.current) close(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Could not create this workspace. Try again.'); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  const title = mode === 'find' ? 'Find workspaces' : mode === 'create' ? 'Create a new workspace' : mode === 'sign-in' ? 'Sign in to another workspace' : 'Add a workspace';
  return <>
    <div ref={trigger} className="chat-workspace-switcher-anchor">
      <Popover label={`Switch workspaces… (${name})`} panelLabel="Workspaces" role="menu" floating align="start"
        className="sp-menu chat-workspace-switcher" panelClassName="sp-menu-content chat-workspace-switcher-content"
        triggerClassName="sp-button sp-button--secondary" trigger={<WorkspaceIcon workspace={current ?? { name }} className="chat-workspace-mark"/>}>
        {dismiss => <>
          <button type="button" role="menuitem" aria-label={name} aria-current="true" className="workspace-switcher-current" onClick={() => dismiss()}>
            <WorkspaceIcon workspace={current ?? { name }}/>
            <span className="workspace-switcher-identity"><strong>{name}</strong></span>
            <Check size={16} aria-hidden="true"/>
          </button>
          {items.some(item => item.id !== value) && <hr role="separator"/>}
          {items.filter(item => item.id !== value).map(item => <button type="button" role="menuitem" aria-label={item.name} className="workspace-switcher-other" key={item.id} onClick={() => { dismiss(); onChange(item.id); }}>
            <WorkspaceIcon workspace={item}/>
            <span className="workspace-switcher-identity"><strong>{item.name}</strong></span>
          </button>)}
          <hr role="separator"/>
          <button type="button" role="menuitem" onClick={() => { dismiss(); setQuery(''); setWorkspaceName(''); setError(''); setMode('add'); }}><span className="workspace-switcher-icon"><Plus size={21} aria-hidden="true"/></span>Add a workspace</button>
        </>}
      </Popover>
    </div>
    {mode && <Dialog open onClose={close} onBeforeClose={() => !submitting.current} title={title}>
      <div className="workspace-add">
        {mode !== 'add' && <Button className="workspace-add-back" variant="ghost" size="sm" disabled={busy} onClick={() => { setError(''); setMode('add'); }}><ArrowLeft size={16} aria-hidden="true"/>Back</Button>}
        {mode === 'add' && <div className="workspace-add-choices">
          <button type="button" onClick={() => setMode('sign-in')}><span><UserPlus size={21}/></span>Sign in to another workspace</button>
          <button type="button" onClick={() => setMode('find')}><span><MagnifyingGlass size={21}/></span>Find workspaces</button>
          <button type="button" disabled={!onCreate} onClick={() => setMode('create')}><span><Plus size={21}/></span>Create a new workspace</button>
        </div>}
        {mode === 'find' && <>
          <p>Workspaces available to your current account.</p>
          <label className="workspace-add-search"><MagnifyingGlass size={18} aria-hidden="true"/><input type="search" aria-label="Search workspaces" placeholder="Search workspaces" autoFocus value={query} onChange={event => setQuery(event.target.value)}/></label>
          <div className="workspace-find-results">{items.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item => <button type="button" aria-label={`Open ${item.name}`} key={item.id} onClick={() => { close(); if (item.id !== value) onChange(item.id); }}>
            <WorkspaceIcon workspace={item}/><span className="workspace-switcher-identity"><strong>{item.name}</strong><small>{workspaceAddress(item.id)}</small></span>{item.id === value && <Check size={16} aria-hidden="true"/>}
          </button>)}</div>
          {!items.some(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p role="status">No matching workspaces</p>}
          <small>Missing a workspace? Ask its owner to add your account.</small>
        </>}
        {mode === 'create' && <form onSubmit={event => void create(event)}>
          <label>Workspace name<input required maxLength={100} autoFocus placeholder="e.g. Design team" value={workspaceName} disabled={busy} onChange={event => setWorkspaceName(event.target.value)}/></label>
          {error && <p role="alert">{error}</p>}
          <Button type="submit" variant="primary" disabled={!workspaceName.trim() || busy} loading={busy}>Create workspace</Button>
        </form>}
        {mode === 'sign-in' && <><p>Sign in to access another account’s workspaces. This changes the account in this browser.</p><AuthScreen embedded onBusyChange={pending => { submitting.current = pending; if (alive.current) setBusy(pending); }} onAuthenticated={() => { window.dispatchEvent(new Event('space:session-expired')); close(); }}/></>}
      </div>
    </Dialog>}
  </>;
}
