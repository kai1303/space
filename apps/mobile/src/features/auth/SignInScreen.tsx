import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { errorText } from '../../shared/api/request';

export function SignInScreen({ onSubmit }: { onSubmit: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !email.trim() || !password) return;
    setBusy(true); setError('');
    try { await onSubmit(email.trim(), password); }
    catch (reason) { setError(errorText(reason)); setBusy(false); }
  };
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={styles.title}>Sign in to Space</Text>
      <TextInput style={styles.input} accessibilityLabel="Email" placeholder="Email" value={email} onChangeText={setEmail}
        autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" />
      <TextInput style={styles.input} accessibilityLabel="Password" placeholder="Password" value={password} onChangeText={setPassword}
        secureTextEntry autoComplete="current-password" textContentType="password" onSubmitEditing={() => { void submit(); }} />
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Sign in" accessibilityState={{ busy }} onPress={() => { void submit(); }} style={styles.button}>
        {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Sign in</Text>}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#d0d7de', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  error: { color: '#cf222e' },
  button: { backgroundColor: '#1f6feb', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 16 },
});
