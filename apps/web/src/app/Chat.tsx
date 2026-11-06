import { HuddleProvider } from '../features/huddles/Huddles.js';
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
  useEffect(() => {
    const expired = () => { void refetch(); };
    window.addEventListener('space:session-expired', expired);
    return () => window.removeEventListener('space:session-expired', expired);
  }, [refetch]);
  if (isPending) return <AccessLoading />;
  if (error) return <AccessFrame screen="session-error" title="Let’s try that again."><p role="alert">Cannot check your session. Please try again.</p><Button onClick={() => void refetch()}>Try again</Button></AccessFrame>;
  if (!session) return <AuthScreen />;
  const invitation = new URLSearchParams(window.location.search).get('invite');
  if(invitation) return <InviteAcceptance token={invitation} onAccepted={id=>window.location.assign(`/chat?workspace=${encodeURIComponent(id)}`)} onCancel={()=>window.location.assign('/chat')}/>;
  if(window.location.pathname.startsWith('/w/')) return <WorkspaceAddress slug={decodeURIComponent(window.location.pathname.slice(3))} email={session.user.email}/>;
  return <SocketSession key={`${session.user.id}:${session.session.id}`}><CallingProvider actor={session.user.id}><HuddleProvider><ChatWorkspace profile={{ id: session.user.id, display_name: session.user.name }} /></HuddleProvider></CallingProvider></SocketSession>;
}
