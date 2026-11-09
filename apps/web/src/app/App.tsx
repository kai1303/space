import { ConversationLinkLoading } from './shell/ConversationLinkLoading.js';
import { lazy, Suspense } from 'react';
const LaunchPage = lazy(() => import('../features/launch/LaunchPage.js').then(module => ({ default: module.LaunchPage })));

const Chat = lazy(() => import('./Chat.js').then(module => ({ default: module.Chat })));
const Gallery = lazy(() => import('../gallery/DesignSystemGallery.js').then(module => ({ default: module.DesignSystemGallery })));
const Preview = lazy(() => import('../gallery/WorkspacePreview.js').then(module => ({ default: module.WorkspacePreview })));

export function App() {
  const { pathname, hash, search } = window.location;
  const query = new URLSearchParams(search);
  const chatLink = ['workspace', 'channel', 'message', 'invite', 'connect'].some(key => query.has(key)) || hash === '#chat-messages';
  const landingAnchor = ['', '#workspace', '#agents', '#connections', '#workflows', '#setup', '#toolkit', '#start', '#faq', '#launch-main'].includes(hash);
  const landing = pathname === '/' && !chatLink && landingAnchor;
  const chat = pathname === '/chat' || pathname.startsWith('/c/') || pathname.startsWith('/w/') || (pathname === '/' && chatLink);
  return <Suspense fallback={pathname.startsWith('/c/') ? <ConversationLinkLoading /> : <p role="status" className="sp-sr-only">Loading Space…</p>}>
    {landing ? <LaunchPage /> : chat ? <Chat /> : pathname === '/workspace' ? <Preview /> : <Gallery />}
  </Suspense>;
}
