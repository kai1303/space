import type { ChatEvent } from '@space/contracts';

export function mergeEvents(previous: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
  const events = new Map(previous.map(event => [event.sequence, event]));
  for (const event of incoming) events.set(event.sequence, event);
  return [...events.values()].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1);
}
