import type { ChatMessage } from '@space/contracts';

export type Outgoing = { id: string; text: string; status: 'sending' | 'failed'; error?: string };

// A retry keeps its client_message_id, so the server deduplicates a send whose ack was lost.
export function sending(list: Outgoing[], entry: Pick<Outgoing, 'id' | 'text'>): Outgoing[] {
  const next: Outgoing = { id: entry.id, text: entry.text, status: 'sending' };
  return list.some(item => item.id === entry.id) ? list.map(item => item.id === entry.id ? next : item) : [...list, next];
}

export function failed(list: Outgoing[], id: string, error: string): Outgoing[] {
  return list.map(item => item.id === id ? { ...item, status: 'failed', error } : item);
}

export function reconcile(list: Outgoing[], incoming: ChatMessage[], viewerId: string): Outgoing[] {
  const confirmed = new Set(incoming
    .filter(message => message.author.kind === 'human' && message.author.id === viewerId && message.client_message_id)
    .map(message => message.client_message_id));
  return confirmed.size ? list.filter(item => !confirmed.has(item.id)) : list;
}
