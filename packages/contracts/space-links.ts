const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export type ConversationLink = { channel: string; thread?: string; message?: string };

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

export function conversationPath(channel: string, thread?: string, message?: string) {
  const room = compact(channel), reply = thread && compact(thread);
  if (!room || (thread && !reply)) return undefined;
  if (message) {
    const key = compact(message);
    return key ? `/c/${room}/message/${key}` : undefined;
  }
  return reply ? `/c/${room}/thread/${reply}` : `/c/${room}`;
}

export function isChannelPath(path: string) {
  return /^\/c\/[A-Za-z0-9_-]{21}[AQgw]$/.test(path);
}

export function assetDownloadPath(id: string) {
  if (!uuid.test(id)) throw new Error('Invalid asset ID.');
  return `/v1/assets/${id}/download`;
}

export function assetPagePath(id: string, page: number) {
  if (!uuid.test(id) || !Number.isSafeInteger(page) || page < 1) throw new Error('Invalid PDF page link.');
  return `/file/${id}?page=${page}`;
}

export function parseAssetPagePath(path: string) {
  const match = /^\/file\/([^/?]+)\?page=([1-9]\d*)$/.exec(path);
  if (!match || !uuid.test(match[1]!)) return undefined;
  const page = Number(match[2]);
  return Number.isSafeInteger(page) ? { id: match[1]!, page } : undefined;
}

export function isAssetDownloadPath(path: string) {
  const match = /^\/v1\/assets\/([^/]+)\/download$/.exec(path);
  return !!match && uuid.test(match[1]!);
}

export function isMessagePath(path: string) {
  return /^\/c\/[A-Za-z0-9_-]{21}[AQgw]\/message\/[A-Za-z0-9_-]{21}[AQgw]$/.test(path);
}

export function parseConversationPath(path: string): ConversationLink {
  const match = /^\/c\/([^/]+)(?:\/(thread|message)\/([^/]+))?\/?$/.exec(path);
  if (!match) throw new Error('Invalid conversation link.');
  const channel = expand(match[1]!);
  if (match[2] === 'message') return { channel, message: expand(match[3]!) };
  return { channel, thread: match[3] ? expand(match[3]) : undefined };
}

export function messagePath(channel: string, message: string) {
  const path = conversationPath(channel, undefined, message);
  if (!path || !message) throw new Error('Invalid message link.');
  return path;
}

// Lowercase base64url keys can also be valid user-chosen workspace slugs.
const slugShape = /^[a-z0-9-]+$/;
export function workspacePath(id: string) {
  const key = compact(id);
  if (!key) return '/chat?workspace=' + encodeURIComponent(id);
  return '/w/' + (slugShape.test(key) ? '~' : '') + key;
}

export function workspaceIdFromPath(path: string) {
  const match = /^\/w\/(~?)([A-Za-z0-9_-]{21}[AQgw])(?:\/(?:activity|dms|spacebot|files|todos|agents|threads|huddles|drafts|saved|directories|vault))?\/?$/.exec(path);
  if (!match || (!match[1] && slugShape.test(match[2]!))) return undefined;
  return expand(match[2]!);
}

export function parseWorkspaceProfileLink(href: string) {
  const match = /^(\/w\/~?[\w-]+)\?profile=(user|agent)(?::|%3[aA])([\da-fA-F-]+)$/.exec(href);
  if (!match || !uuid.test(match[3]!)) return undefined;
  const workspace = workspaceIdFromPath(match[1]!);
  if (!workspace) return undefined;
  return { workspace, kind: match[2] as 'user' | 'agent', id: match[3]! };
}

export function sessionPath(id: string) {
  const key = compact(id);
  return key ? '/s/' + key : undefined;
}

export function sessionMessagePath(session:string,task:string,part:'request'|'response') {
  const base=sessionPath(session);
  return base && uuid.test(task) ? base+'?turn='+task+'&part='+part : undefined;
}

export function parseSessionPath(path: string) {
  const match = /^\/s\/([^/]+)\/?$/.exec(path);
  if (!match) throw new Error('Invalid session link.');
  return expand(match[1]!);
}
