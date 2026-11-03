const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
export function isUnicodeEmoji(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
    && /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u.test(value)
    && [...graphemes.segment(value)].length === 1;
}
