import type { ChannelSummary } from '@space/contracts';
import { router } from 'expo-router';
import { FlatList } from 'react-native';
import { useLoad } from '../../shared/api/useLoad';
import { Centered } from '../../shared/ui/Centered';
import { Row } from '../../shared/ui/Row';
import { useAuth } from '../auth/AuthProvider';
import { visibleChannels } from './channels';

export function ChannelList({ workspaceId }: { workspaceId: string }) {
  const { api } = useAuth();
  const state = useLoad(() => api.listAll<ChannelSummary>(`/workspaces/${encodeURIComponent(workspaceId)}/channels`), [api, workspaceId]);
  const channels = state.data ? visibleChannels(state.data) : undefined;
  if (!channels) return state.error ? <Centered message={state.error} action={{ label: 'Try again', onPress: state.reload }} /> : <Centered busy />;
  if (!channels.length) return <Centered message="You have not joined any channels in this workspace yet." />;
  return (
    <FlatList data={channels} keyExtractor={item => item.id} onRefresh={state.reload} refreshing={state.loading}
      renderItem={({ item }) => (
        <Row title={`# ${item.name}`} subtitle={item.topic || undefined}
          onPress={() => router.push({ pathname: '/channels/[channelId]', params: { channelId: item.id, name: item.name } })} />
      )} />
  );
}
