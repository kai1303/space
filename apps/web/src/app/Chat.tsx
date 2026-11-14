import { workspacePath, workspaceIdFromPath } from '@space/contracts';
import { SessionTeam } from '../features/agents/SessionTeam.js';
import { ConversationLinkLoading } from './shell/ConversationLinkLoading.js';
import { CallingProvider } from '../features/calling/Calling.js';
import { InviteAcceptance } from '../features/workspace/invitations/InviteAcceptance.js';
import { WorkspaceAddress } from '../features/workspace/WorkspaceAddress.js';
import { SocketSession } from '../shared/realtime/SocketSession.js';
import { useEffect } from 'react';
import { Button } from '@space/ui/primitives';
import { authClient } from '../features/auth/auth-client.js';
import { AuthScreen } from '../features/auth/AuthScreen.js';
import { ChatWorkspace } from './ChatWorkspace.js';
import { AccessFrame, AccessLoading } from '../features/auth/AccessFrame.js';

import '../features/chat/chat.css';
import '../features/composer/composer-drafts.css';
export function Chat() {
  useEffect(() => { document.title = 'Space — Chat'; }, []);
  const { data: session, isPending, error, refetch } = authClient.useSession();
  const browserActor = session?.user.id ?? null;
  useEffect(() => {
    if (!isPending) window.spaceDesktop?.browserAccountChanged?.(error ? null : browserActor);
  }, [browserActor, error, isPending]);
  useEffect(() => {
    const expired = () => { void refetch(); };
    window.addEventListener('space:session-expired', expired);
    return () => window.removeEventListener('space:session-expired', expired);
  }, [refetch]);
  if (isPending) return location.pathname.startsWith('/c/') ? <ConversationLinkLoading /> : <AccessLoading />;
  if (error) return <AccessFrame screen="session-error" title="Let’s try that again."><p role="alert">Cannot check your session. Please try again.</p><Button onClick={() => void refetch()}>Try again</Button></AccessFrame>;
  if (!session) return <AuthScreen />;
  const review = /^\/review\/([\da-f-]{36})\/?$/i.exec(location.pathname);
  if (review) return <SocketSession key={session.session.id}><SessionTeam id={review[1]!} viewer={session.user.id} standalone/></SocketSession>;
  const invitation = new URLSearchParams(window.location.search).get('invite');
  if(invitation) return <InviteAcceptance token={invitation} onAccepted={id=>window.location.assign(workspacePath(id))} onCancel={()=>window.location.assign('/chat')}/>;
  if (location.pathname.startsWith('/w/') && !workspaceIdFromPath(location.pathname)) {
    const slug = location.pathname.slice(3).replace(/\/$/, '').replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return <WorkspaceAddress slug={slug} email={session.user.email}/>;
  }
  return <SocketSession key={`${session.user.id}:${session.session.id}`}><CallingProvider actor={session.user.id}><ChatWorkspace profile={{ id: session.user.id, display_name: session.user.name }} /></CallingProvider></SocketSession>;
}
