import { AppError, record } from './validation.js';

export type RichAttributes = {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean;
  link?: string; list?: 'ordered' | 'bullet'; blockquote?: boolean; 'code-block'?: boolean | string;
};
export type RichDocument = { ops: { insert: string; attributes?: RichAttributes }[] };
export const MAX_MESSAGE_DOCUMENT_BYTES = 32768;
export const MAX_MESSAGE_DOCUMENT_CHARACTERS = 10001;

export function parseRichDocument(input: unknown): RichDocument {
  const value = record(input, ['ops']);
  if (!Array.isArray(value.ops) || !value.ops.length || value.ops.length > 20000) throw new AppError(400, 'invalid_document');
  const ops: RichDocument['ops'] = [];
  let characters = 0;
  for (const raw of value.ops) {
    const op = record(raw, ['insert', 'attributes']);
    if (typeof op.insert !== 'string' || !op.insert.length || op.insert.includes('\0')) throw new AppError(400, 'invalid_document');
    characters += op.insert.length;
    if (characters > MAX_MESSAGE_DOCUMENT_CHARACTERS) throw new AppError(400, 'document_too_large');
    const attributes: RichAttributes = {};
    if (op.attributes !== undefined) {
      const a = record(op.attributes, ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'list', 'blockquote', 'code-block']);
      for (const key of ['bold', 'italic', 'underline', 'strike', 'code', 'blockquote'] as const) {
        if (a[key] === undefined) continue;
        if (typeof a[key] !== 'boolean') throw new AppError(400, 'invalid_document');
        attributes[key] = a[key];
      }
      if (a.link !== undefined) {
        if (typeof a.link !== 'string' || a.link.length > 2048 || a.link.includes('\0')) throw new AppError(400, 'invalid_document_link');
        let url: URL;
        try { url = new URL(a.link); } catch { throw new AppError(400, 'invalid_document_link'); }
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new AppError(400, 'invalid_document_link');
        attributes.link = url.href;
      }
      if (a.list !== undefined) {
        if (a.list !== 'ordered' && a.list !== 'bullet') throw new AppError(400, 'invalid_document');
        attributes.list = a.list;
      }
      if (a['code-block'] !== undefined) {
        const code = a['code-block'];
        if (typeof code !== 'boolean' && !(typeof code === 'string' && code.length > 0 && code.length <= 80 && !code.includes('\0'))) throw new AppError(400, 'invalid_document');
        attributes['code-block'] = code;
      }
    }
    ops.push(Object.keys(attributes).length ? { insert: op.insert, attributes } : { insert: op.insert });
  }
  const document = { ops };
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_MESSAGE_DOCUMENT_BYTES) throw new AppError(400, 'document_too_large');
  return document;
}
