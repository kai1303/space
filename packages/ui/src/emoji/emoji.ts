import rawData, { type Emoji, type EmojiMartData } from '@emoji-mart/data';
import type { RichDocument } from '@space/contracts';
// The package declares its interfaces but omits the JSON default export type.
const data = rawData as unknown as EmojiMartData;

export const emojiCategories = [
  ['people', 'Smileys & People'], ['nature', 'Animals & Nature'],
  ['foods', 'Food & Drink'], ['activity', 'Activities'],
  ['places', 'Travel & Places'], ['objects', 'Objects'],
  ['symbols', 'Symbols'], ['flags', 'Flags'],
] as const;
const aliases = data.aliases;
export function emojiById(id: string): Emoji | undefined {
  const key = Object.hasOwn(aliases, id) ? aliases[id]! : id;
  return Object.hasOwn(data.emojis, key) ? data.emojis[key] : undefined;
}
export type EmojiPreferences = { skin: number; recent: string[] };
export function emojiPreferences(): EmojiPreferences {
  try {
    const value = JSON.parse(window.localStorage.getItem('space:emoji-preferences') ?? '{}');
    return { skin: Number.isInteger(value?.skin) && value.skin >= 1 && value.skin <= 6 ? value.skin : 1, recent: Array.isArray(value?.recent) ? value.recent.filter((id: unknown) => typeof id === 'string' && emojiById(id)).slice(0, 24) : [] };
  } catch { return { skin: 1, recent: [] }; }
}
export function saveEmojiPreferences(value: EmojiPreferences) {
  try { window.localStorage.setItem('space:emoji-preferences', JSON.stringify(value)); } catch { /* Storage is optional. */ }
}
export function emojiNative(id: string, skin = 1) {
  const emoji = emojiById(id);
  return (emoji?.skins[skin - 1] ?? emoji?.skins[0])?.native ?? `:${id}:`;
}
const entries = Object.values(data.emojis);
const names = new Map<string, string[]>();
for (const [alias, id] of Object.entries(aliases)) names.set(id, [...(names.get(id) ?? []), alias]);
const searchable = entries.map(emoji => ({ emoji, text: [emoji.id, emoji.name, ...emoji.keywords, ...(names.get(emoji.id) ?? [])].join(' ').toLowerCase().replaceAll('_', ' ') }));
export function searchEmoji(query: string, limit = 80): Emoji[] {
  const value = query.toLowerCase().replace(/^:|:$/g, '').trim();
  if (!value) return [];
  const exact = emojiById(value);
  const words = value.replaceAll('_', ' ').split(/\s+/);
  return [...(exact ? [exact] : []), ...searchable.filter(item => item.emoji !== exact && words.every(word => item.text.includes(word))).map(item => item.emoji)].sort((a, b) => (a === exact ? -1 : b === exact ? 1 : Number(b.id.startsWith(value)) - Number(a.id.startsWith(value)))).slice(0, limit);
}
export function categoryEmoji(category: string): Emoji[] {
  return (data.categories.find(item => item.id === category)?.emojis ?? []).flatMap(id => data.emojis[id] ? [data.emojis[id]!] : []);
}
export function replaceEmojiShortcodes(value: string, skin = 1) {
  return value.replace(/https?:\/\/\S+|:([\w+\-]+):(?::skin-tone-([2-6]):)?/g, (match, id?: string, tone?: string) => id && emojiById(id) ? emojiNative(id, tone ? Number(tone) : skin) : match);
}
// Block formatting belongs to the terminal newline, which may be a separate op.
export function emojiDocument(document: RichDocument, skin = 1): RichDocument {
  const codeLines = new Set<number>();
  let line = 0;
  for (const op of document.ops) for (const char of op.insert) if (char === '\n') { if (op.attributes?.['code-block']) codeLines.add(line); line++; }
  line = 0;
  return { ops: document.ops.map(op => ({ ...op, insert: op.insert.split('\n').map((part, index) => {
    if (index) line++;
    return op.attributes?.code || op.attributes?.['code-block'] || op.attributes?.link || codeLines.has(line) ? part : replaceEmojiShortcodes(part, skin);
  }).join('\n') })) };
}
export function emojiCompletion(text: string, cursor: number) {
  const match = /(?:^|\s):([\w+\-]{2,})$/.exec(text.slice(0, cursor));
  if (!match) return null;
  const query = match[1]!;
  return { start: cursor - query.length - 1, length: query.length + 1, items: searchEmoji(query, 8) };
}
