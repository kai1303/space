import { Stack, useLocalSearchParams } from 'expo-router';
import { ChannelScreen } from '../../../src/features/chat/ChannelScreen';

export default function ChannelRoute() {
  const { channelId, name } = useLocalSearchParams<{ channelId: string; name?: string }>();
  return <><Stack.Screen options={{ title: name ? `# ${name}` : 'Channel' }} /><ChannelScreen channelId={channelId} /></>;
}
