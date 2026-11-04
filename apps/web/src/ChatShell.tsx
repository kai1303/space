import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { IconButton, Menu, surfaceMotion, useSidebarMotion } from '@space/ui';
import { ArrowLeft, ArrowRight, BookOpen, CaretDown, Check, ClockCounterClockwise, House, ChatCircle, List, MagnifyingGlass, Moon, Sun, Users, X } from '@phosphor-icons/react';
import { UserSettings } from './UserProfile.js';
import { SpaceLogo } from './SpaceLogo.js';

export function ChatShell({ onHome, onDirectMessages, directMessagesActive = false, name, user, userId, onNameChange, onSearch, onMembers, workspaces = [], workspace = '', onWorkspaceChange, sidebarWidth = 220, onBack, onForward, history = [], activity, children }: {
  onHome?: () => void;
  onDirectMessages?: () => void;
  directMessagesActive?: boolean;
  name: string;
  user: string;
  userId?: string;
  onNameChange?: (name: string) => void;
  onSearch?: () => void;
  onMembers?: () => void;
  workspaces?: { id: string; name: string }[];
  workspace?: string;
  onWorkspaceChange?: (id: string) => void;
  sidebarWidth?: number;
  onBack?: () => void;
  onForward?: () => void;
  history?: { label: string; onSelect: () => void }[];
  activity?: ReactNode;
  children: ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const shell = useSidebarMotion<HTMLDivElement>(sidebarOpen, '(max-width: 720px)', '.chat-sidebar', workspace);
  const reduced = useReducedMotion();
  const menu = useRef<HTMLDivElement>(null);
  function openSearch() { setSidebarOpen(false); onSearch?.(); }
  const [theme, setTheme] = useState(() => {
    try { return window.localStorage.getItem('space-theme') === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem('space-theme', theme); } catch {}
  }, [theme]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && onSearch) {
        event.preventDefault(); setSidebarOpen(false); onSearch();
      }
      if (event.key === 'Escape' && sidebarOpen) { setSidebarOpen(false); menu.current?.querySelector('button')?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onSearch, sidebarOpen]);
  return <div ref={shell} className={`chat-app ${sidebarOpen ? 'chat-app--sidebar-open' : ''}`} style={{ '--chat-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
    <a className="chat-skip" href="#chat-messages">Skip to messages</a>
    <header className="chat-topbar">
      <a className="chat-topbar-brand" href="/chat" aria-label="Space home"><SpaceLogo inverse /></a>
      <div className="chat-history-controls" role="toolbar" aria-label="History Navigation">
        <IconButton label="Back in history" disabled={!onBack} onClick={onBack}><ArrowLeft size={20} /></IconButton>
        <IconButton label="Forward in history" disabled={!onForward} onClick={onForward}><ArrowRight size={20} /></IconButton>
        {history.length ? <Menu label="Show history" menuLabel="Recent conversations" className="chat-history-menu" floating trigger={<ClockCounterClockwise size={20} />} items={history} /> : <IconButton label="Show history" disabled><ClockCounterClockwise size={20} /></IconButton>}
      </div>
      <div className="chat-mobile-toggle" ref={menu}><IconButton label={sidebarOpen ? 'Close conversations' : 'Open conversations'} aria-expanded={sidebarOpen} aria-controls="chat-conversations" onClick={() => setSidebarOpen(open => !open)}><List size={20} /></IconButton></div>
      <button className="chat-global-search" disabled={!onSearch} onClick={openSearch}><MagnifyingGlass size={17} /><span>Search {name}</span><kbd>⌘ K</kbd></button>
      <div className="chat-topbar-end">{activity}<a className="chat-system-link" href="/design-system" aria-label="Open design system"><BookOpen size={19} /></a></div>
    </header>
    <div className="chat-body">
      <nav className="chat-rail" aria-label="Main navigation">
        {onWorkspaceChange ? <WorkspacePicker items={workspaces} value={workspace} onChange={onWorkspaceChange} compact /> : <div className="chat-workspace-mark" title={name}><SpaceLogo icon /></div>}
        <a href="/chat" className={`chat-rail-item${directMessagesActive ? '' : ' is-active'}`} aria-current={directMessagesActive ? undefined : 'page'} onClick={event => { if (onHome) { event.preventDefault(); onHome(); } }}><span className="chat-rail-icon"><House size={20} weight="fill" /></span><span>Home</span></a>
        {onDirectMessages && <button className={`chat-rail-item${directMessagesActive ? ' is-active' : ''}`} aria-current={directMessagesActive ? 'page' : undefined} onClick={onDirectMessages}><span className="chat-rail-icon"><ChatCircle size={22} weight={directMessagesActive ? 'fill' : 'regular'} /></span><span>DMs</span></button>}
        {onSearch && <button className="chat-rail-item" onClick={openSearch}><span className="chat-rail-icon"><MagnifyingGlass size={20} /></span><span>Search</span></button>}
        {onMembers && <button className="chat-rail-item" onClick={onMembers}><span className="chat-rail-icon"><Users size={23} /></span><span>Members</span></button>}
        <div className="chat-rail-bottom">
          <IconButton label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={21} /> : <Moon size={21} />}</IconButton>
          <UserSettings user={user} userId={userId} onNameChange={onNameChange} />
        </div>
      </nav>
      <div className="chat-main-area" onClick={event => {
        if ((event.target as Element).closest('.sp-channel, .sp-sidebar-create, .sp-sidebar-compose')) setSidebarOpen(false);
      }}>{children}</div>
      <AnimatePresence>{sidebarOpen && <motion.button {...surfaceMotion(reduced, 'scrim')} key="sidebar-scrim" className="chat-sidebar-backdrop" aria-label="Close conversation navigation" onClick={() => { setSidebarOpen(false); menu.current?.querySelector('button')?.focus(); }}><X size={22} /></motion.button>}</AnimatePresence>
    </div>
  </div>;
}

export function WorkspacePicker({ items, value, onChange, onMembers, compact = false }: { items: { id: string; name: string }[]; value: string; onChange: (value: string) => void; onMembers?: () => void; compact?: boolean }) {
  const name = items.find(item => item.id === value)?.name ?? 'Workspace';
  return <Menu label={compact ? `Switch workspaces… (${name})` : `${name} Actions`} menuLabel="Workspaces" className={compact ? 'chat-workspace-switcher' : 'chat-workspace-picker'} floating align="start"
    trigger={compact ? <span className="chat-workspace-mark"><SpaceLogo icon /></span> : <><span>{name}</span><CaretDown size={15} /></>}
    items={[
      ...items.map(item => ({ label: item.name, icon: <span className="chat-workspace-menu-icon" aria-hidden="true">{item.id === value ? <Check size={18} /> : item.name.slice(0, 1).toUpperCase()}</span>, onSelect: () => { if (item.id !== value) onChange(item.id); } })),
      ...(onMembers ? [{ label: 'Workspace members', icon: <Users size={18} />, separatorBefore: true, onSelect: onMembers }] : []),
    ]} />;
}
