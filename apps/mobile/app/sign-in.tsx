import { Redirect } from 'expo-router';
import { useAuth } from '../src/features/auth/AuthProvider';
import { SignInScreen } from '../src/features/auth/SignInScreen';

export default function SignInRoute() {
  const auth = useAuth();
  if (auth.status === 'signed-in') return <Redirect href="/" />;
  return <SignInScreen onSubmit={auth.signIn} />;
}
