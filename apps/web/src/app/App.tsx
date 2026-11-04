import { DesignSystemGallery } from '../gallery/DesignSystemGallery.js';
import { Chat } from './Chat.js';
import { WorkspacePreview } from '../gallery/WorkspacePreview.js';

export function App() {
  const { pathname, hash } = window.location;
  if (pathname.startsWith('/w/') || pathname === '/chat' || (pathname === '/' && (!hash || hash === '#chat-messages'))) return <Chat />;
  if (pathname === '/workspace') return <WorkspacePreview />;
  return <DesignSystemGallery />;
}
