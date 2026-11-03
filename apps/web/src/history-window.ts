import type { ChatMessage, MessagePage } from '@space/contracts';

export const HISTORY_LIMIT = 500;
export type HistoryDirection = 'older' | 'newer' | 'latest';

function ordered(messages: ChatMessage[]) {
  return [...new Map(messages.map(message => [message.id, message])).values()]
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
export function appendLive(previous: MessagePage, incoming: ChatMessage[], pinned: boolean): MessagePage {
  if (!incoming.length || previous.has_newer) return previous;
  const messages = ordered([...previous.messages, ...incoming]);
  if (messages.length > HISTORY_LIMIT && !pinned) return { ...previous, has_newer: true };
  return boundaries({ ...previous, has_older: previous.has_older || messages.length > HISTORY_LIMIT }, messages.slice(-HISTORY_LIMIT));
}
