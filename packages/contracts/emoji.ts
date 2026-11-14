const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const emojiStart = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u;
export function isUnicodeEmoji(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
    && emojiStart.test(value)
    && [...graphemes.segment(value)].length === 1;
}

export function isEmojiOnlyText(text: string): boolean {
  const trimmed = text.trim();
  if (!emojiStart.test(trimmed)) return false;
  for (const { segment } of graphemes.segment(trimmed)) {
    if (segment.trim() && !emojiStart.test(segment)) return false;
  }
  return true;
}
