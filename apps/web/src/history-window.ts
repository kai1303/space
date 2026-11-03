import type { ChatMessage, MessagePage } from '@space/contracts';

export const HISTORY_LIMIT = 500;
export type HistoryDirection = 'older' | 'newer' | 'latest';

function ordered(messages: ChatMessage[]) {
  const unique = new Map<string, ChatMessage>();
  for (const message of messages) {
    const previous = unique.get(message.id);
    const latest = !previous || BigInt(message.reaction_sequence ?? '0') >= BigInt(previous.reaction_sequence ?? '0') ? message : previous;
    unique.set(message.id, previous?.reply_count !== undefined || message.reply_count !== undefined
      ? { ...latest, reply_count: Math.max(previous?.reply_count ?? 0, message.reply_count ?? 0) } : latest);
  }
  return [...unique.values()]
    .sort((a, b) => BigInt(a.sequence!) < BigInt(b.sequence!) ? -1 : BigInt(a.sequence!) > BigInt(b.sequence!) ? 1 : 0);
}
function boundaries(page: MessagePage, messages: ChatMessage[]): MessagePage {
  return { ...page, messages, older_cursor: messages[0]?.sequence ?? null, newer_cursor: messages.at(-1)?.sequence ?? null };
}
export function mergePage(previous: MessagePage | null, page: MessagePage, direction: HistoryDirection): MessagePage {
  if (!previous) return page;
  if (direction === 'latest') {
    const live = previous.has_newer ? [] : previous.messages.filter(message => BigInt(message.sequence!) > BigInt(page.event_cursor));
    const messages = ordered([...page.messages, ...live]);
    return boundaries({ ...page, has_older: page.has_older || messages.length > HISTORY_LIMIT }, messages.slice(-HISTORY_LIMIT));
  }
  const messages = ordered([...previous.messages, ...page.messages]);
  const overflow = messages.length > HISTORY_LIMIT;
  return boundaries({ ...page,
    has_older: direction === 'older' ? page.has_older : previous.has_older || overflow,
    has_newer: direction === 'newer' ? page.has_newer : previous.has_newer || overflow,
  }, direction === 'older' ? messages.slice(0, HISTORY_LIMIT) : messages.slice(-HISTORY_LIMIT));
}
export function appendLive(previous: MessagePage, incoming: ChatMessage[], pinned: boolean, rootsOnly = false): MessagePage {
  if (rootsOnly) {
    const counts = new Map<string, number>();
    for (const message of incoming) if (message.thread_root_id && message.reply_count !== undefined)
      counts.set(message.thread_root_id, Math.max(counts.get(message.thread_root_id) ?? 0, message.reply_count));
    incoming = [
      ...incoming.filter(message => !message.thread_root_id || message.thread_root_id === message.id),
      ...previous.messages.filter(message => counts.has(message.id)).map(message => ({ ...message, reply_count: Math.max(message.reply_count ?? 0, counts.get(message.id)!) })),
    ];
  }
  const present = new Set([...previous.messages.map(message => message.id), ...incoming.filter(message => !message.reaction_sequence || message.reaction_sequence === '0').map(message => message.id)]);
  incoming = incoming.filter(message => present.has(message.id));
  if (!incoming.length) return previous;
  if (previous.has_newer) {
    const ids = new Set(previous.messages.map(message => message.id));
    return { ...previous, messages: ordered([...previous.messages, ...incoming.filter(message => ids.has(message.id))]) };
  }
  const messages = ordered([...previous.messages, ...incoming]);
  if (messages.length > HISTORY_LIMIT && !pinned) {
    const ids = new Set(previous.messages.map(message => message.id));
    return { ...previous, has_newer: true, messages: ordered([...previous.messages, ...incoming.filter(message => ids.has(message.id))]) };
  }
  return boundaries({ ...previous, has_older: previous.has_older || messages.length > HISTORY_LIMIT }, messages.slice(-HISTORY_LIMIT));
}
