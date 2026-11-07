import type { AssetAttachment, ChatMessage, RichDocument } from '@space/contracts';
import type { Socket } from 'socket.io-client';
import { socketCommand as command } from '../../shared/realtime/socket-command.js';

export type MessageAttempt = { current?: { content: string; id: string } };
// Retain a failed attempt's ID, so retrying after a lost acknowledgment is safe.
export function messageSender(socket: Socket, channel: string, thread?: string, state: MessageAttempt = {}) {
  return async (text: string, document?: RichDocument, files: Pick<AssetAttachment, 'id' | 'description'>[] = [], broadcastConfirmed = false) => {
    const descriptions = Object.fromEntries(files.filter(file => file.description?.trim()).map(file => [file.id, file.description!.trim()]));
    const assets = { ...(files.length ? { asset_ids: files.map(file => file.id) } : {}), ...(Object.keys(descriptions).length ? { asset_descriptions: descriptions } : {}) };
    const content = JSON.stringify({ text, document, ...assets });
    if (state.current?.content !== content) state.current = { content, id: crypto.randomUUID() };
    const attempt = state.current;
    const saved = await command<ChatMessage>(socket, 'message.send', { channel_id: channel, text, ...(broadcastConfirmed ? { broadcast_confirmed: true } : {}), ...assets, ...(document ? { document } : {}), client_message_id: attempt.id, ...(thread ? { thread_id: thread } : {}) });
    if (state.current === attempt) state.current = undefined;
    return saved;
  };
}
