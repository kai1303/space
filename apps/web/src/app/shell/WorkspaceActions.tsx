import { useState } from 'react';
import { NavigationIcon } from '@space/ui/navigation';
import { Popover } from '@space/ui/primitives';
import { SignOutButton } from '../../features/auth/AuthScreen.js';
import { NotificationPreferences } from '../../features/notifications/Notifications.js';
import { WorkspaceInvitations } from '../../features/workspace/invitations/WorkspaceInvitations.js';
import { WorkspaceIcon, workspaceAddress, type WorkspaceChoice } from './WorkspaceSwitcher.js';

export function WorkspaceActions({ workspace, onMembers, onSettings }: {
  workspace: WorkspaceChoice;
  onMembers: () => void;
  onSettings: () => void;
}) {
  const [dialog, setDialog] = useState<'invitations' | 'preferences'>();
  const address = workspaceAddress(workspace.id);
  return <>
    <Popover label={`${workspace.name} Actions`} role="menu" floating align="start"
      className="sp-menu chat-workspace-picker" panelClassName="sp-menu-content chat-workspace-picker-content"
      triggerClassName="sp-button sp-button--secondary sp-button--md"
      trigger={<><span>{workspace.name}</span><NavigationIcon name="chevron" size={15}/></>}>
      {close => <>
        <div className="workspace-actions-heading">
          <WorkspaceIcon workspace={workspace}/>
          <div className="workspace-switcher-identity"><strong>{workspace.name}</strong><small title={address}>{address}</small></div>
        </div>
        <hr/>
        <button type="button" role="menuitem" onClick={() => { close(); setDialog('invitations'); }}>Invite people to {workspace.name}</button>
        <hr/>
        <button type="button" role="menuitem" onClick={() => { close(); setDialog('preferences'); }}>Notification preferences</button>
        <button type="button" role="menuitem" onClick={() => { close(); onSettings(); }}>Workspace settings</button>
        <button type="button" role="menuitem" onClick={() => { close(); onMembers(); }}>Workspace members</button>
        <hr/>
        <SignOutButton role="menuitem"/>
      </>}
    </Popover>
    {dialog === 'invitations' && <WorkspaceInvitations workspace={workspace.id} onClose={() => setDialog(undefined)}/>}
    {dialog === 'preferences' && <NotificationPreferences workspace={workspace.id} onClose={() => setDialog(undefined)}/>}
  </>;
}
