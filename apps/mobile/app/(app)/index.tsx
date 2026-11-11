import { Stack } from 'expo-router';
import { WorkspaceList } from '../../src/features/workspaces/WorkspaceList';

export default function WorkspacesRoute() {
  return <><Stack.Screen options={{ title: 'Workspaces' }} /><WorkspaceList /></>;
}
