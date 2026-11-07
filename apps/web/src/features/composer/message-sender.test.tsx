import { describe, it, expect, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { ChatEvent } from '@space/contracts';
import { mergeEvents } from '../chat/merge-events.js';
import { messageSender } from './message-sender.js';

it('sends ordered attachment descriptions and changes retry identity when descriptions change', async () => {
  const emitWithAck = vi.fn().mockRejectedValue(new Error('timed out'));
  const socket = { connected: true, timeout: () => ({ emitWithAck }) } as unknown as Socket;
  const send = messageSender(socket, 'channel');
  const files = [{ id: 'b', description: 'Blue square' }, { id: 'a' }];
  await expect(send('', undefined, files)).rejects.toThrow('timed out');
  await expect(send('', undefined, files)).rejects.toThrow('timed out');
  await expect(send('', undefined, [{ id: 'b', description: 'Red square' }, { id: 'a' }])).rejects.toThrow('timed out');
  const payloads = emitWithAck.mock.calls.map(call => call[1]);
  expect(payloads[0].asset_ids).toEqual(['b', 'a']);
  expect(payloads[0].asset_descriptions).toEqual({ b: 'Blue square' });
  expect(payloads[1].client_message_id).toBe(payloads[0].client_message_id);
  expect(payloads[2].client_message_id).not.toBe(payloads[0].client_message_id);
});

describe('chat delivery state', () => {
  it('forwards formatting and keeps the same retry ID only for the same document', async () => {
    const emitWithAck = vi.fn().mockRejectedValueOnce(new Error('timed out')).mockRejectedValueOnce(new Error('timed out')).mockResolvedValue({ data: {} });
    const socket = { connected: true, timeout: () => ({ emitWithAck }) } as unknown as Socket;
    const send = messageSender(socket, 'channel');
    const bold = { ops: [{ insert: 'Hello', attributes: { bold: true } }, { insert: '\n' }] };
    const italic = { ops: [{ insert: 'Hello', attributes: { italic: true } }, { insert: '\n' }] };
    await expect(send('Hello', bold)).rejects.toThrow('timed out');
    await expect(send('Hello', bold)).rejects.toThrow('timed out');
    await send('Hello', italic);
    expect(emitWithAck.mock.calls[0]![1].document).toEqual(bold);
    expect(emitWithAck.mock.calls[1]![1].client_message_id).toBe(emitWithAck.mock.calls[0]![1].client_message_id);
    expect(emitWithAck.mock.calls[2]![1].client_message_id).not.toBe(emitWithAck.mock.calls[0]![1].client_message_id);
  });
  it('deduplicates replay and orders cursors without losing bigint precision', () => {
    const event = (sequence: string) => ({ sequence, channel_id: 'channel', type: 'message.created' }) as ChatEvent;
    expect(mergeEvents([event('9007199254740993')], [event('9007199254740992'), event('9007199254740993')]).map(e => e.sequence))
      .toEqual(['9007199254740992', '9007199254740993']);
  });
  it('reuses a client message ID after a lost acknowledgment, then creates a new ID for a new send', async () => {
    const emitWithAck = vi.fn().mockRejectedValueOnce(new Error('timed out')).mockResolvedValue({ data: {} });
    const socket = { connected: true, timeout: () => ({ emitWithAck }) } as unknown as Socket;
    const send = messageSender(socket, 'channel', 'thread');
    await expect(send('Hello')).rejects.toThrow('timed out');
    await send('Hello'); await send('Hello');
    const first = emitWithAck.mock.calls[0]![1], retry = emitWithAck.mock.calls[1]![1], next = emitWithAck.mock.calls[2]![1];
    expect(first.client_message_id).toBe(retry.client_message_id);
    expect(next.client_message_id).not.toBe(first.client_message_id);
    expect(first.thread_id).toBe('thread');
  });
  it('does not buffer offline messages and accidentally send them after changing channels', async () => {
    const emitWithAck = vi.fn();
    const socket = { connected: false, timeout: () => ({ emitWithAck }) } as unknown as Socket;
    await expect(messageSender(socket, 'old-channel')('Hello')).rejects.toThrow('Reconnecting');
    expect(emitWithAck).not.toHaveBeenCalled();
  });
});

it('keeps attachment retry IDs stable and changes identity when attachments change', async () => {
  const emitWithAck = vi.fn().mockRejectedValue(new Error('timed out'));
  const socket = { connected: true, timeout: () => ({ emitWithAck }) } as unknown as Socket;
  const send = messageSender(socket, 'channel');
  await expect(send('', undefined, [{ id: 'asset-a' }])).rejects.toThrow('timed out');
  await expect(send('', undefined, [{ id: 'asset-a' }])).rejects.toThrow('timed out');
  await expect(send('', undefined, [{ id: 'asset-b' }])).rejects.toThrow('timed out');
  const payloads = emitWithAck.mock.calls.map(call => call[1]);
  expect(payloads[0].asset_ids).toEqual(['asset-a']);
  expect(payloads[1].client_message_id).toBe(payloads[0].client_message_id);
  expect(payloads[2].client_message_id).not.toBe(payloads[0].client_message_id);
});
it('retains retry identity when an attachment sender is recreated with session draft state', async () => {
  const emitWithAck = vi.fn().mockRejectedValueOnce(new Error('timed out')).mockResolvedValue({ data: {} });
  const socket = { connected: true, timeout: () => ({ emitWithAck }) } as unknown as Socket;
  const state = {};
  await expect(messageSender(socket, 'channel', undefined, state)('', undefined, [{ id: 'asset' }])).rejects.toThrow('timed out');
  await messageSender(socket, 'channel', undefined, state)('', undefined, [{ id: 'asset' }]);
  expect(emitWithAck.mock.calls[1]![1].client_message_id).toBe(emitWithAck.mock.calls[0]![1].client_message_id);
  await messageSender(socket, 'channel', undefined, state)('', undefined, [{ id: 'asset' }]);
  expect(emitWithAck.mock.calls[2]![1].client_message_id).not.toBe(emitWithAck.mock.calls[0]![1].client_message_id);
});
