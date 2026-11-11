import { Pressable, Text } from 'react-native';
import { useAuth } from './AuthProvider';

export function SignOutButton() {
  const { signOut } = useAuth();
  return (
    <Pressable accessibilityRole="button" hitSlop={8} onPress={() => { void signOut(); }}>
      <Text style={{ color: '#1f6feb', fontSize: 16 }}>Sign out</Text>
    </Pressable>
  );
}
