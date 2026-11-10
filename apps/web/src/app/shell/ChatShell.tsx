import { readChatTheme } from './chat-theme.js';
import {useNotificationDelivery} from '../../features/notifications/Notifications.js';
import type {NotificationItem} from '@space/contracts';
import { useEffect, useLayoutEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { IconButton, Menu } from '@space/ui/primitives';
import { NavigationIcon } from '@space/ui/navigation';
import { motionTransition, surfaceMotion, useSidebarMotion } from '@space/ui/motion';
import { ArrowLeft, ArrowRight, BookOpen, Globe, CaretDown, Check, ClockCounterClockwise, House, ChatCircle, Bell, List, MagnifyingGlass, Moon, Sun, Users, X, Robot, Files, CheckCircle, Sparkle, GearSix } from '@phosphor-icons/react';
import { UserSettings } from '../../features/profile/UserProfile.js';
import { SpaceLogo } from '../../shared/branding/SpaceLogo.js';
import { WorkspaceIcon, WorkspaceSwitcher, type WorkspaceChoice } from './WorkspaceSwitcher.js';

export type RailDestination = 'spacebot' | 'files' | 'todos' | 'agents';
export function ChatShell({ notificationDelivery, onNavigate, activeDestination, adminItems, onActivity, activityActive = false, notificationCount = 0, onHome, onDirectMessages, directMessagesActive = false, name, user, userId, onNameChange, onSearch, onMembers, workspaces = [], workspace = '', onWorkspaceChange, onCreateWorkspace, sidebarWidth = 220, onBack, onForward, history = [], activity, children }: {
  notificationDelivery?: {workspace:string;channel?:string;onOpen:(item:NotificationItem)=>void};
  onNavigate?: (destination: RailDestination) => void;
  activeDestination?: RailDestination;
  adminItems?: { label: string; onSelect: () => void }[];
  onActivity?: () => void;
  activityActive?: boolean;
  notificationCount?: number;
  onHome?: () => void;
  onDirectMessages?: () => void;
  directMessagesActive?: boolean;
  name: string;
  user: string;
  userId?: string;
  onNameChange?: (name: string) => void;
  onSearch?: () => void;
  onMembers?: () => void;
  workspaces?: WorkspaceChoice[];
  workspace?: string;
  onWorkspaceChange?: (id: string) => void;
  onCreateWorkspace?: (name: string) => Promise<void>;
  sidebarWidth?: number;
  onBack?: () => void;
  onForward?: () => void;
  history?: { label: string; onSelect: () => void }[];
  activity?: ReactNode;
  children: ReactNode;
}) {
  const deliveredCount=useNotificationDelivery(notificationDelivery?.workspace??'',notificationDelivery?.channel,notificationDelivery?.onOpen??(()=>{}));
  if(notificationDelivery)notificationCount=deliveredCount;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const shell = useSidebarMotion<HTMLDivElement>(sidebarOpen, '(max-width: 720px)', '.chat-sidebar', workspace);
  const reduced = useReducedMotion();
  const railId = useId();
  const railIcon = (active: boolean, content: ReactNode) => <span className="chat-rail-icon">
    {active && (reduced ? <span className="chat-rail-active" aria-hidden="true"/> : <motion.span className="chat-rail-active" aria-hidden="true" layoutId="active-rail-item" transition={motionTransition(false,.22)}/>)}
    <span className="chat-rail-glyph">{content}</span>
  </span>;
  useEffect(() => { setSidebarOpen(false); }, [activeDestination, activityActive, directMessagesActive]);
  const menu = useRef<HTMLDivElement>(null);
  function openSearch() { setSidebarOpen(false); onSearch?.(); }
  const [theme, setTheme] = useState(readChatTheme);
  useLayoutEffect(() => {
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
        <IconButton label="Back in history" disabled={!onBack} onClick={onBack}><NavigationIcon name="back" size={20}/></IconButton>
        <IconButton label="Forward in history" disabled={!onForward} onClick={onForward}><NavigationIcon name="forward" size={20}/></IconButton>
        {history.length ? <Menu label="Show history" menuLabel="Recent conversations" className="chat-history-menu" floating trigger={<NavigationIcon name="history" size={20}/>} items={history} /> : <IconButton label="Show history" disabled><NavigationIcon name="history" size={20}/></IconButton>}
      </div>
      <div className="chat-mobile-toggle" hidden={!!activeDestination || activityActive || directMessagesActive} ref={menu}><IconButton label={sidebarOpen ? 'Close conversations' : 'Open conversations'} aria-expanded={sidebarOpen} aria-controls="chat-conversations" onClick={() => setSidebarOpen(open => !open)}><List size={20} /></IconButton></div>
      <button className="chat-global-search" disabled={!onSearch} onClick={openSearch}><NavigationIcon name="search" size={17}/><span>Search {name}</span><kbd>⌘ K</kbd></button>
      <div className="chat-topbar-end">{window.spaceDesktop?.openBrowser && <IconButton label="Open browser" onClick={() => window.spaceDesktop?.openBrowser?.()}><Globe size={19}/></IconButton>}{activity}<a className="chat-system-link" href="/design-system" aria-label="Open design system"><BookOpen size={19} /></a></div>
    </header>
    <div className="chat-body">
      <LayoutGroup id={railId}><nav className="chat-rail" aria-label="Main navigation">
        {onWorkspaceChange ? <WorkspaceSwitcher items={workspaces} value={workspace} onChange={onWorkspaceChange} onCreate={onCreateWorkspace} /> : <div className="chat-workspace-mark" title={name}><SpaceLogo icon /></div>}
        {onNavigate && <button className={`chat-rail-item${activeDestination === 'spacebot' ? ' is-active' : ''}`} aria-current={activeDestination === 'spacebot' ? 'page' : undefined} onClick={() => onNavigate('spacebot')}>{railIcon(activeDestination === 'spacebot',<NavigationIcon name="spacebot" size={32} active={activeDestination === 'spacebot'}/>)}<span>Spacebot</span></button>}
        <a href="/chat" className={`chat-rail-item${directMessagesActive || activityActive || activeDestination ? '' : ' is-active'}`} aria-current={directMessagesActive || activityActive || activeDestination ? undefined : 'page'} onClick={event => { if (onHome) { event.preventDefault(); onHome(); } }}>{railIcon(!directMessagesActive && !activityActive && !activeDestination,<NavigationIcon name="home" active={!directMessagesActive && !activityActive && !activeDestination}/>)}<span>Home</span></a>
        {onDirectMessages && <button className={`chat-rail-item${directMessagesActive ? ' is-active' : ''}`} aria-current={directMessagesActive ? 'page' : undefined} onClick={onDirectMessages}>{railIcon(directMessagesActive,<NavigationIcon name="dms" active={directMessagesActive}/>)}<span>DMs</span></button>}
        {onActivity && <button className={`chat-rail-item${activityActive ? ' is-active' : ''}`} aria-current={activityActive ? 'page' : undefined} aria-label={`Activity${notificationCount ? ` (${notificationCount} unread)` : ''}`} onClick={onActivity}>{railIcon(activityActive,<><NavigationIcon name="activity" active={activityActive}/>{notificationCount > 0 && <span className="notification-rail-count" aria-hidden="true">{notificationCount > 99 ? '99+' : notificationCount}</span>}</>)}<span>Activity</span></button>}
        {onNavigate && ([['files', 'Files'], ['agents', 'Agents & tools']] as const).map(([view, label]) => <button key={view} className={`chat-rail-item${activeDestination === view ? ' is-active' : ''}`} aria-current={activeDestination === view ? 'page' : undefined} onClick={() => onNavigate(view)}>{railIcon(activeDestination === view,<NavigationIcon name={view} active={activeDestination === view}/>)}<span>{label}</span></button>)}
        {!!adminItems?.length && <Menu label="Admin" menuLabel="Admin tools" className="chat-admin-menu" floating align="start" trigger={<><span className="chat-rail-icon"><NavigationIcon name="admin"/></span><span>Admin</span></>} items={adminItems}/>}
        <div className="chat-rail-bottom">
          <IconButton label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={21} /> : <Moon size={21} />}</IconButton>
          <UserSettings user={user} userId={userId} onNameChange={onNameChange} />
        </div>
      </nav></LayoutGroup>
      <div className="chat-main-area" onClick={event => {
        if ((event.target as Element).closest('.sp-channel, .sp-sidebar-create, .sp-sidebar-compose, .sp-sidebar-utilities button')) setSidebarOpen(false);
      }}>{children}</div>
      <AnimatePresence>{sidebarOpen && <motion.button {...surfaceMotion(reduced, 'scrim')} key="sidebar-scrim" className="chat-sidebar-backdrop" aria-label="Close conversation navigation" onClick={() => { setSidebarOpen(false); menu.current?.querySelector('button')?.focus(); }}><X size={22} /></motion.button>}</AnimatePresence>
    </div>
  </div>;
}

export function WorkspacePicker({ items, value, onChange, onMembers, compact = false }: { items: WorkspaceChoice[]; value: string; onChange: (value: string) => void; onMembers?: () => void; compact?: boolean }) {
  const name = items.find(item => item.id === value)?.name ?? 'Workspace';
  return <Menu label={compact ? `Switch workspaces… (${name})` : `${name} Actions`} menuLabel="Workspaces" className={compact ? 'chat-workspace-switcher' : 'chat-workspace-picker'} floating align="start"
    trigger={compact ? <span className="chat-workspace-mark"><SpaceLogo icon /></span> : <><span>{name}</span><NavigationIcon name="chevron" size={15}/></>}
    items={[
      ...items.map(item => ({ label: item.name, icon: <><WorkspaceIcon workspace={item} className="chat-workspace-menu-icon"/>{item.id === value && <Check size={14} aria-hidden="true"/>}</>, onSelect: () => { if (item.id !== value) onChange(item.id); } })),
      ...(onMembers ? [{ label: 'Workspace members', icon: <Users size={18} />, separatorBefore: true, onSelect: onMembers }] : []),
    ]} />;
}
