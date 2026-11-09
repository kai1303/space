import type { Socket } from 'socket.io-client';

type Clock = { start: number; timer: ReturnType<typeof setTimeout> };
const deadlineMs = 15_000;
const clocks = new WeakMap<Socket, Map<string, Clock>>();

// Both timestamps belong to the sending browser and to this physical connection.
export function enableLiveReceipts(socket: Socket) {
  if (!clocks.has(socket)) clocks.set(socket, new Map());
}
export function clearLiveReceipts(socket: Socket) {
  for (const sample of clocks.get(socket)?.values() ?? []) clearTimeout(sample.timer);
  clocks.delete(socket);
}
export function receiptSubmissionTime(socket: Socket) {
  return clocks.has(socket) ? performance.now() : undefined;
}
export function attachLiveReceipt(socket: Socket, data: object, start: number) {
  const samples = clocks.get(socket);
  if (!samples || samples.size >= 16) return data;
  const remaining = deadlineMs - (performance.now() - start);
  if (remaining <= 0) return data;
  const id = crypto.randomUUID();
  const timer = setTimeout(() => samples.delete(id), remaining);
  samples.set(id, { timer, start });
  return { ...data, receipt_id: id };
}
export function finishLiveReceipt(socket: Socket, id: string) {
  const samples = clocks.get(socket), clock = samples?.get(id);
  if (!clock) return null;
  const elapsed = performance.now() - clock.start;
  clearTimeout(clock.timer); samples!.delete(id);
  return elapsed;
}
