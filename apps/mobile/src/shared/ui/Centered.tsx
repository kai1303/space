import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

type Props = { message?: string; busy?: boolean; action?: { label: string; onPress: () => void } };

export function Centered({ message, busy, action }: Props) {
  return (
    <View style={styles.root}>
      {busy ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {action ? (
        <Pressable accessibilityRole="button" onPress={action.onPress} style={styles.button}>
          <Text style={styles.buttonText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  message: { fontSize: 16, textAlign: 'center' },
  button: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1f6feb' },
  buttonText: { color: '#ffffff', fontWeight: '600' },
});
