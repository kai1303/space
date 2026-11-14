import type { AssetAttachment, EncryptedDm, ChatMessage, RichDocument } from '@space/contracts';
import type { Socket } from 'socket.io-client';
import { socketCommand as command } from '../../shared/realtime/socket-command.js';

export type MessageAttempt = { current?: { content: string; id: string } };

export function messageContent(text: string, document: RichDocument | undefined, files: Pick<AssetAttachment, 'id' | 'description'>[]) {
  const descriptions = Object.fromEntries(files.filter(file => file.description?.trim()).map(file => [file.id, file.description!.trim()]));
  return {
    text, ...(document ? { document } : {}),
    ...(files.length ? { asset_ids: files.map(file => file.id) } : {}),
    ...(Object.keys(descriptions).length ? { asset_descriptions: descriptions } : {}),
  };
}

export function sendMessage(socket: Socket, channel: string, thread: string | undefined, id: string, content: ReturnType<typeof messageContent> | {encrypted:EncryptedDm}, broadcastConfirmed = false, expectedActor?: string) {
  return command<ChatMessage>(socket, 'message.send', {
    channel_id: channel, client_message_id: id, ...content, ...(expectedActor && { expected_actor: expectedActor }),
    ...(thread ? { thread_id: thread } : {}), ...(broadcastConfirmed ? { broadcast_confirmed: true } : {}),
  });
}

// Retain a failed attempt's ID, so retrying after a lost acknowledgment is safe.
export function messageSender(socket: Socket, channel: string, thread?: string, state: MessageAttempt = {}) {
  return async (text: string, document?: RichDocument, files: Pick<AssetAttachment, 'id' | 'description'>[] = [], broadcastConfirmed = false) => {
    const payload = messageContent(text, document, files);
    const content = JSON.stringify(payload);
    if (state.current?.content !== content) state.current = { content, id: crypto.randomUUID() };
    const attempt = state.current;
    const saved = await sendMessage(socket, channel, thread, attempt.id, payload, broadcastConfirmed);
    if (state.current === attempt) state.current = undefined;
    return saved;
  };
}
