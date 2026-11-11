import { Stack, useLocalSearchParams } from 'expo-router';
import { ChannelList } from '../../../src/features/channels/ChannelList';

export default function ChannelsRoute() {
  const { workspaceId, name } = useLocalSearchParams<{ workspaceId: string; name?: string }>();
  return <><Stack.Screen options={{ title: name ?? 'Channels' }} /><ChannelList workspaceId={workspaceId} /></>;
}
