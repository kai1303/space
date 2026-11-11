import { Redirect, router } from 'expo-router';
import { FlatList } from 'react-native';
import { useLoad } from '../../shared/api/useLoad';
import { Centered } from '../../shared/ui/Centered';
import { Row } from '../../shared/ui/Row';
import { useAuth } from '../auth/AuthProvider';

type Workspace = { id: string; name: string };
const open = (workspace: Workspace) => ({ pathname: '/workspaces/[workspaceId]' as const, params: { workspaceId: workspace.id, name: workspace.name } });

export function WorkspaceList() {
  const { api } = useAuth();
  const state = useLoad(() => api.listAll<Workspace>('/workspaces'), [api]);
  const items = state.data;
  if (!items) return state.error ? <Centered message={state.error} action={{ label: 'Try again', onPress: state.reload }} /> : <Centered busy />;
  if (!items.length) return <Centered message="You are not in a workspace yet. Ask an admin to invite you." />;
  if (items.length === 1) return <Redirect href={open(items[0]!)} />;
  return (
    <FlatList data={items} keyExtractor={item => item.id} onRefresh={state.reload} refreshing={state.loading}
      renderItem={({ item }) => <Row title={item.name} onPress={() => router.push(open(item))} />} />
  );
}
