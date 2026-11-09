const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export type ConversationLink = { channel: string; thread?: string };

function compact(id: string) {
  if (!uuid.test(id)) return undefined;
  const bytes = id.replaceAll('-', '').match(/../g)!.map(pair => parseInt(pair, 16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').slice(0, 22);
}

function expand(segment: string) {
  // Sixteen bytes leave four zero padding bits in the last base64 digit.
  if (!/^[A-Za-z0-9_-]{21}[AQgw]$/.test(segment)) throw new Error('Invalid conversation link.');
  const bytes = atob(segment.replaceAll('-', '+').replaceAll('_', '/') + '==');
  const hex = Array.from(bytes, byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function conversationPath(channel: string, thread?: string) {
  const room = compact(channel), reply = thread && compact(thread);
  if (!room || (thread && !reply)) return undefined;
  return reply ? `/c/${room}/thread/${reply}` : `/c/${room}`;
}

export function parseConversationPath(path: string): ConversationLink {
  const match = /^\/c\/([^/]+)(?:\/thread\/([^/]+))?\/?$/.exec(path);
  if (!match) throw new Error('Invalid conversation link.');
  return { channel: expand(match[1]!), thread: match[2] ? expand(match[2]) : undefined };
}
