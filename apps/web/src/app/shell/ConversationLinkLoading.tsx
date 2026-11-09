import type { CSSProperties } from 'react';
import { ConversationLoading } from '../../features/chat/ConversationLoading.js';
import { SpaceLogo } from '../../shared/branding/SpaceLogo.js';
import { readChatTheme } from './chat-theme.js';
import { useSidebarWidth } from './useSidebarWidth.js';
import '../../features/chat/chat.css';

export function ConversationLinkLoading() {
  const { sidebarWidth } = useSidebarWidth();
  return <div className="chat-app" data-theme={readChatTheme()} style={{ '--chat-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
    <div className="chat-topbar" aria-hidden="true">
      <div className="chat-topbar-brand"><SpaceLogo inverse /></div>
      <div className="chat-global-search" /><div className="chat-topbar-end" />
    </div>
    <div className="chat-body">
      <div className="chat-rail" aria-hidden="true" />
      <div className="chat-main-area"><div className="chat-layout">
        <div className="chat-sidebar" aria-hidden="true"><div className="sp-workspace-sidebar" /></div>
        <ConversationLoading />
      </div></div>
    </div>
  </div>;
}
