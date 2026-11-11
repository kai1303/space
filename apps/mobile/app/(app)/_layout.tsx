import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../src/features/auth/AuthProvider';
import { SignOutButton } from '../../src/features/auth/SignOutButton';
import { RealtimeProvider } from '../../src/shared/realtime/RealtimeProvider';
import { Centered } from '../../src/shared/ui/Centered';

export default function SignedInLayout() {
  const auth = useAuth();
  if (auth.status === 'loading') return <Centered busy />;
  if (auth.status === 'unavailable') return <Centered message="Space is not reachable right now." action={{ label: 'Try again', onPress: auth.retry }} />;
  if (auth.status === 'signed-out') return <Redirect href="/sign-in" />;
  return (
    <RealtimeProvider session={auth.session}>
      <Stack screenOptions={{ headerRight: () => <SignOutButton /> }} />
    </RealtimeProvider>
  );
}
