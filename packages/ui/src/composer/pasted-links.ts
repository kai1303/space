import { find } from 'linkifyjs';
import type Quill from 'quill';
import type { Delta } from 'quill';
import { safeLink } from '../rich-text/rich-text.js';

export function formatPastedLinks(editor: Quill, DeltaType: typeof Delta) {
  const clipboard = editor.clipboard;
  const convert = clipboard.convert.bind(clipboard);
  clipboard.convert = (input, formats) => {
    const pasted = convert(input, formats);
    if (formats?.code || formats?.['code-block']) return pasted;
    const formatted = new DeltaType();
    for (const op of pasted.ops) {
      const { insert, attributes } = op;
      if (typeof insert !== 'string' || attributes?.link || attributes?.mention || attributes?.code || attributes?.['code-block']) {
        formatted.push(op);
        continue;
      }
      let from = 0;
      for (const match of find(insert, 'url', { defaultProtocol: 'https' })) {
        const href = safeLink(match.href);
        if (!href || href.length > 2048) continue;
        formatted.insert(insert.slice(from, match.start), attributes);
        formatted.insert(match.value, { ...attributes, link: href });
        from = match.end;
      }
      formatted.insert(insert.slice(from), attributes);
    }
    return formatted;
  };
}
