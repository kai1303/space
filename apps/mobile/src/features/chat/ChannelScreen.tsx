import { useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { ChatMessage } from '@space/contracts';
import { Centered } from '../../shared/ui/Centered';
import type { Outgoing } from './outbox';
import { MAX_PENDING, MAX_TEXT, useChannel } from './useChannel';

type Item = { key: string; message: ChatMessage } | { key: string; outgoing: Outgoing };

export function ChannelScreen({ channelId }: { channelId: string }) {
  const chat = useChannel(channelId);
  const [draft, setDraft] = useState('');
  if (chat.noAccess) return <Centered message="You can't open this channel." action={{ label: 'Back to channels', onPress: () => router.back() }} />;
  // The list is inverted: index 0 is the newest row at the bottom.
  const items: Item[] = [
    ...[...chat.outgoing].reverse().map(outgoing => ({ key: `out:${outgoing.id}`, outgoing })),
    ...[...(chat.page?.messages ?? [])].reverse().map(message => ({ key: message.id, message })),
  ];
  const submit = () => { if (chat.send(draft)) setDraft(''); };
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}>
      {chat.error ? <Text accessibilityRole="alert" style={styles.banner}>{chat.error}</Text> : null}
      {!chat.page ? <Centered busy={!chat.error} /> : (
        <FlatList inverted data={items} keyExtractor={item => item.key} contentContainerStyle={styles.list}
          renderItem={({ item }) => 'message' in item ? <MessageRow message={item.message} /> : <OutgoingRow entry={item.outgoing} onRetry={chat.retry} />}
          onEndReached={() => { void chat.loadOlder(); }} onEndReachedThreshold={0.5}
          onScroll={event => chat.setAtLatest(event.nativeEvent.contentOffset.y < 48)} scrollEventThrottle={100}
          ListFooterComponent={chat.loadingOlder ? <ActivityIndicator style={styles.older} /> : undefined} />
      )}
      <View style={styles.composer}>
        <TextInput style={styles.input} value={draft} onChangeText={setDraft} placeholder="Message" accessibilityLabel="Message" multiline maxLength={MAX_TEXT} />
        <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={!draft.trim() || chat.outgoing.length >= MAX_PENDING} onPress={submit} style={styles.send}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const body = message.deleted_at ? 'This message was deleted.' : message.text || (message.attachments?.length ? 'Shared a file.' : '');
  return (
    <View style={styles.row}>
      <Text style={styles.meta}>{message.author.name} · {time}</Text>
      <Text style={message.deleted_at ? styles.deleted : styles.text}>{body}</Text>
    </View>
  );
}

function OutgoingRow({ entry, onRetry }: { entry: Outgoing; onRetry: (id: string) => void }) {
  const isFailed = entry.status === 'failed';
  return (
    <Pressable disabled={!isFailed} onPress={() => onRetry(entry.id)} accessibilityRole={isFailed ? 'button' : undefined}
      accessibilityHint={isFailed ? 'Sends the message again' : undefined} style={styles.row}>
      <Text style={styles.text}>{entry.text}</Text>
      <Text style={isFailed ? styles.failed : styles.meta}>{isFailed ? `${entry.error ?? 'Not sent.'} Tap to retry.` : 'Sending…'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: { padding: 10, backgroundColor: '#fff8c5', color: '#4d2d00' },
  list: { paddingVertical: 8 },
  older: { marginVertical: 12 },
  row: { paddingHorizontal: 16, paddingVertical: 6 },
  meta: { fontSize: 12, color: '#57606a' },
  text: { fontSize: 16 },
  deleted: { fontSize: 16, fontStyle: 'italic', color: '#57606a' },
  failed: { fontSize: 12, color: '#cf222e' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#d0d7de' },
  input: { flex: 1, maxHeight: 140, borderWidth: 1, borderColor: '#d0d7de', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  send: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1f6feb' },
  sendText: { color: '#ffffff', fontWeight: '600' },
});
