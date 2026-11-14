import { ConversationLinkLoading } from './shell/ConversationLinkLoading.js';
import { lazy, Suspense } from 'react';
const LaunchPage = lazy(() => import('../features/launch/LaunchPage.js').then(module => ({ default: module.LaunchPage })));

const FileWindow = lazy(() => import('../features/files/FileWindow.js'));
const OfficePanel = lazy(() => import('../features/files/OfficePanel.js'));
const Chat = lazy(() => import('./Chat.js').then(module => ({ default: module.Chat })));
const Gallery = lazy(() => import('../gallery/DesignSystemGallery.js').then(module => ({ default: module.DesignSystemGallery })));
const Preview = lazy(() => import('../gallery/WorkspacePreview.js').then(module => ({ default: module.WorkspacePreview })));

const AgentPreview = lazy(() => import('../gallery/AgentSessionPreview.js').then(module => ({ default: module.AgentSessionPreview })));

export function App() {
  const { pathname, hash, search } = window.location;
  const file = /^\/file\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(pathname);
  if (file) return <Suspense fallback={<p role="status">Opening file…</p>}><FileWindow id={file[1]!}/></Suspense>;
  const office = /^\/office\/(library|file)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(pathname);
  if (office) return <Suspense fallback={<p role="status">Opening Office editor…</p>}>
    <OfficePanel library={office[1] === 'library'} id={office[2]!} />
  </Suspense>;
  const query = new URLSearchParams(search);
  const chatLink = ['workspace', 'channel', 'message', 'invite', 'connect'].some(key => query.has(key)) || hash === '#chat-messages';
  const landingAnchor = ['', '#workspace', '#agents', '#connections', '#workflows', '#setup', '#toolkit', '#start', '#faq', '#launch-main'].includes(hash);
  const landing = pathname === '/' && !chatLink && landingAnchor;
  const chat = pathname === '/chat' || pathname.startsWith('/c/') || pathname.startsWith('/s/') || /^\/review\/[a-f0-9-]{36}\/?$/i.test(pathname) || pathname.startsWith('/w/') || (pathname === '/' && chatLink);
  return <Suspense fallback={pathname.startsWith('/c/') ? <ConversationLinkLoading /> : <p role="status" className="sp-sr-only">Loading Space…</p>}>
    {pathname === '/preview/agent-session' ? <AgentPreview /> : landing ? <LaunchPage /> : chat ? <Chat /> : pathname === '/workspace' ? <Preview /> : <Gallery />}
  </Suspense>;
}
