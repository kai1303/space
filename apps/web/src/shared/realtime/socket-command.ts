import { attachLiveReceipt, receiptSubmissionTime } from './live-receipts.js';
import type { Socket } from 'socket.io-client';

type Queue = { tail: Promise<void>; pending: number; generation: number };
const queues = new WeakMap<Socket, Queue>();
function queue(socket: Socket) {
  let state = queues.get(socket);
  if (!state) { state = { tail: Promise.resolve(), pending: 0, generation: 0 }; queues.set(socket, state); }
  return state;
}
export function invalidateSocketCommands(socket: Socket) { queue(socket).generation++; }

// The server serializes commands. Never buffer a command into a replacement connection.
export function socketCommand<T>(socket: Socket, event: string, data: object): Promise<T> {
  if (!socket.connected) return Promise.reject(new Error('Reconnecting. Try again when connected.'));
  const state = queue(socket), generation = state.generation;
  if (state.pending >= 128) return Promise.reject(new Error('Too many pending commands. Try again.'));
  const submittedAt = event === 'message.send' ? receiptSubmissionTime(socket) : undefined;
  state.pending++;
  const result = state.tail.then(async () => {
    if (!socket.connected || generation !== state.generation) throw new Error('Connection changed. Try again.');
    const reply = await socket.timeout(8000).emitWithAck(event, submittedAt === undefined ? data : attachLiveReceipt(socket, data, submittedAt));
    if (generation !== state.generation) throw new Error('Connection changed. Try again.');
    if (reply.error) throw new Error(reply.error);
    return reply.data as T;
  }).finally(() => { state.pending--; });
  state.tail = result.then(() => {}, () => {});
  return result;
}
