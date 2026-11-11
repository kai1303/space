import { RailNavigation, type RailDestination, type RailProps } from './RailNavigation.js';
export type { RailDestination } from './RailNavigation.js';
import { readChatTheme } from './chat-theme.js';
import {useNotificationDelivery} from '../../features/notifications/Notifications.js';
import type {NotificationItem} from '@space/contracts';
import { useEffect, useLayoutEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { IconButton, Menu } from '@space/ui/primitives';
import { NavigationIcon } from '@space/ui/navigation';
import { motionTransition, surfaceMotion, useSidebarMotion } from '@space/ui/motion';
import { BookOpen, Globe, List, Moon, Sun, X } from '@phosphor-icons/react';
import { ChannelSearchHeaderContext, type ChannelSearchHeader } from '../../features/search/channel-search-header.js';
import { UserSettings } from '../../features/profile/UserProfile.js';
import { SpaceLogo } from '../../shared/branding/SpaceLogo.js';
import { WorkspaceSwitcher, type WorkspaceChoice } from './WorkspaceSwitcher.js';

export function ChatShell({ renderPreview, notificationDelivery, onNavigate, activeDestination, adminItems, onActivity, activityActive = false, notificationCount = 0, onHome, onDirectMessages, directMessagesActive = false, name, user, userId, onNameChange, onSearch, onMembers, workspaces = [], workspace = '', onWorkspaceChange, onCreateWorkspace, sidebarWidth = 220, onBack, onForward, history = [], activity, children }: {
  renderPreview?: RailProps['renderPreview'];
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
  useEffect(() => { setSidebarOpen(false); }, [activeDestination, activityActive, directMessagesActive]);
  const menu = useRef<HTMLDivElement>(null);
  const [channelSearch, setChannelSearch] = useState<ChannelSearchHeader | null>(null);
  function openSearch() { setSidebarOpen(false); (channelSearch?.edit ?? onSearch)?.(); }
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
      <button className="chat-global-search" disabled={!onSearch} onClick={openSearch}><NavigationIcon name="search" size={17}/><span>{channelSearch?.label ?? `Search ${name}`}</span><kbd>⌘ K</kbd></button>
      <div className="chat-mobile-toggle" hidden={!!activeDestination || activityActive || directMessagesActive} ref={menu}><IconButton label={sidebarOpen ? 'Close conversations' : 'Open conversations'} aria-expanded={sidebarOpen} aria-controls="chat-conversations" onClick={() => setSidebarOpen(open => !open)}><List size={20} /></IconButton></div>
      <div className="chat-topbar-end">{window.spaceDesktop?.openBrowser && <IconButton label="Open browser" onClick={() => window.spaceDesktop?.openBrowser?.()}><Globe size={19}/></IconButton>}{activity}<a className="chat-system-link" href="/design-system" aria-label="Open design system"><BookOpen size={19} /></a></div>
    </header>
    <div className="chat-body">
      <LayoutGroup id={railId}><nav className="chat-rail" aria-label="Main navigation">
        {onWorkspaceChange ? <WorkspaceSwitcher items={workspaces} value={workspace} onChange={onWorkspaceChange} onCreate={onCreateWorkspace} /> : <div className="chat-workspace-mark" title={name}><SpaceLogo icon /></div>}
        <RailNavigation key={workspace} active={activeDestination ?? (activityActive ? 'activity' : directMessagesActive ? 'dms' : 'home')}
          onHome={onHome} onNavigate={onNavigate} onDirectMessages={onDirectMessages} onActivity={onActivity}
          adminItems={adminItems} notificationCount={notificationCount} renderPreview={renderPreview}/>
        <div className="chat-rail-bottom">
          <IconButton label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={21} /> : <Moon size={21} />}</IconButton>
          <UserSettings user={user} userId={userId} onNameChange={onNameChange} />
        </div>
      </nav></LayoutGroup>
      <div className="chat-main-area" onClick={event => {
        if ((event.target as Element).closest('.sp-channel, .sp-sidebar-create, .sp-sidebar-compose, .sp-sidebar-utilities button')) setSidebarOpen(false);
      }}><ChannelSearchHeaderContext.Provider value={setChannelSearch}>{children}</ChannelSearchHeaderContext.Provider></div>
      <AnimatePresence>{sidebarOpen && <motion.button {...surfaceMotion(reduced, 'scrim')} key="sidebar-scrim" className="chat-sidebar-backdrop" aria-label="Close conversation navigation" onClick={() => { setSidebarOpen(false); menu.current?.querySelector('button')?.focus(); }}><X size={22} /></motion.button>}</AnimatePresence>
    </div>
  </div>;
}
