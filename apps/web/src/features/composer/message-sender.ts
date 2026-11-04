import type { ChatMessage, RichDocument } from '@space/contracts';
import type { Socket } from 'socket.io-client';
import { socketCommand as command } from '../../shared/realtime/socket-command.js';

export type MessageAttempt = { current?: { content: string; id: string } };
// Retain a failed attempt's ID, so retrying after a lost acknowledgment is safe.
export function messageSender(socket: Socket, channel: string, thread?: string, state: MessageAttempt = {}) {
  return async (text: string, document?: RichDocument, assetIds: string[] = [], broadcastConfirmed = false) => {
    const content = JSON.stringify({ text, document, ...(assetIds.length ? { asset_ids: assetIds } : {}) });
    if (state.current?.content !== content) state.current = { content, id: crypto.randomUUID() };
    const attempt = state.current;
    const saved = await command<ChatMessage>(socket, 'message.send', { channel_id: channel, text, ...(broadcastConfirmed ? { broadcast_confirmed: true } : {}), ...(assetIds.length ? { asset_ids: assetIds } : {}), ...(document ? { document } : {}), client_message_id: attempt.id, ...(thread ? { thread_id: thread } : {}) });
    if (state.current === attempt) state.current = undefined;
    return saved;
  };
}
