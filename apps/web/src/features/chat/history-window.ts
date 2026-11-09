import type { ChatMessage, MessagePage } from '@space/contracts';

export const HISTORY_LIMIT = 500;
export type HistoryDirection = 'older' | 'newer' | 'latest';

function mergeSessionLinks(previous: ChatMessage['agent_sessions'] = [], incoming: ChatMessage['agent_sessions'] = []) {
  // Match the bounded inline summary returned by message history.
  return [...new Map([...previous, ...incoming].map(session => [session.id, session])).values()].slice(0, 100);
}
function ordered(messages: ChatMessage[]) {
  const unique = new Map<string, ChatMessage>();
  for (const message of messages) {
    const previous = unique.get(message.id);
    const keepPrevious = previous && (previous.deleted_at || (!message.deleted_at &&
      BigInt(previous.reaction_sequence ?? '0') > BigInt(message.reaction_sequence ?? '0')));
    const latest = keepPrevious ? previous : message;
    let updated = previous?.reply_count !== undefined || message.reply_count !== undefined
      ? { ...latest, reply_count: Math.max(previous?.reply_count ?? 0, message.reply_count ?? 0) } : latest;
    if (previous?.agent_sessions || message.agent_sessions) updated = { ...updated, agent_sessions: mergeSessionLinks(previous?.agent_sessions, message.agent_sessions) };
    unique.set(message.id, updated);
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
    const ids = new Set(page.messages.map(message => message.id));
    const deleted = previous.messages.filter(message => message.deleted_at && ids.has(message.id));
    const messages = ordered([...page.messages, ...live, ...deleted]);
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
  const counts = new Map<string, number>(), sessions = new Map<string, NonNullable<ChatMessage['agent_sessions']>>();
  for (const message of incoming) if (message.thread_root_id) {
    if (!message.agent_session_id && message.reply_count !== undefined) counts.set(message.thread_root_id, Math.max(counts.get(message.thread_root_id) ?? 0, message.reply_count));
    if (message.agent_session_id) sessions.set(message.thread_root_id, mergeSessionLinks(sessions.get(message.thread_root_id), [{ id: message.agent_session_id, title: message.text, agent_name: message.author.name }]));
  }
  incoming = [
    ...incoming.filter(message => !rootsOnly || !message.thread_root_id || message.thread_root_id === message.id),
    ...[...previous.messages, ...incoming].filter(message => counts.has(message.id) || sessions.has(message.id)).map(message => ({
      ...message, ...(counts.has(message.id) ? { reply_count: Math.max(message.reply_count ?? 0, counts.get(message.id)!) } : {}),
      ...(sessions.has(message.id) ? { agent_sessions: mergeSessionLinks(message.agent_sessions, sessions.get(message.id)) } : {}),
    })),
  ];
  const present = new Set(previous.messages.map(message => message.id));
  for (const message of incoming) {
    // Replay can already contain a tombstone for a creation newer than the loaded window.
    if (message.deleted_at ? BigInt(message.sequence!) > BigInt(previous.newer_cursor ?? '0') :
      !message.reaction_sequence || message.reaction_sequence === '0') present.add(message.id);
  }
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
