import { MAX_MESSAGE_ASSETS, parseAssetDescriptions, parseAssetIds, parseAssetInput, type AssetAttachment } from './assets.js';
import { parseRichDocument, type RichDocument } from './rich-text.js';
import { AppError, record, text, uuid } from './validation.js';

export type ComposerDraftValue = { document: RichDocument; files: AssetAttachment[] } | { ciphertext: string; asset_ids?: string[] } | null;
export interface ComposerDraftRow { workspace_id: string; destination_name: string; key: string; revision: string; value: ComposerDraftValue }
export interface ComposerDraftPage { items: ComposerDraftRow[]; next: string | null }

export function parseComposerDraftKey(raw: unknown) {
  const parts = text(raw, 90).split(':');
  if (parts.length === 1) {
    const channel = uuid(parts[0]);
    return { key: channel, channel, thread: null, encrypted: false };
  }
  if (parts.length === 2 && parts[0] === 'encrypted') {
    const channel = uuid(parts[1]);
    return { key: `encrypted:${channel}`, channel, thread: null, encrypted: true };
  }
  if (parts.length === 3 && parts[0] === 'thread') {
    const channel = uuid(parts[1]), thread = uuid(parts[2]);
    return { key: `thread:${channel}:${thread}`, channel, thread, encrypted: false };
  }
  throw new AppError(400, 'invalid_draft_key');
}

export function parseComposerDraftCiphertext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 40 || raw.length > 96 * 1024 ||
      raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new AppError(400, 'invalid_ciphertext');
  return raw;
}

function parseValue(raw: unknown, encrypted: boolean): ComposerDraftValue {
  if (raw === null) return null;
  if (encrypted) {
    const { ciphertext, asset_ids } = record(raw, ['ciphertext', 'asset_ids']);
    return { ciphertext: parseComposerDraftCiphertext(ciphertext), ...(asset_ids === undefined ? {} : { asset_ids: parseAssetIds(asset_ids) }) };
  }
  const value = record(raw, ['document', 'files']);
  const doc = record(value.document, ['ops']);
  const document = Array.isArray(doc.ops) && !doc.ops.length ? { ops: [] } : parseRichDocument(doc);
  if (!Array.isArray(value.files) || value.files.length > MAX_MESSAGE_ASSETS) throw new AppError(400, 'invalid_assets');
  const files = value.files.map(raw => {
    const v = record(raw, ['id', 'name', 'size', 'type', 'description']);
    const id = uuid(v.id);
    const description = v.description === undefined ? undefined : parseAssetDescriptions({ [id]: v.description }, [id])?.[id];
    return { id, ...parseAssetInput({ name: v.name, size: v.size, type: v.type }), ...(description ? { description } : {}) };
  });
  parseAssetIds(files.map(file => file.id));
  return { document, files };
}

export function parseComposerDraftMutation(raw: unknown, encrypted: boolean) {
  const v = record(raw, ['base', 'mutation_id', 'value']);
  return { base: v.base === null ? null : uuid(v.base), mutation_id: uuid(v.mutation_id), value: parseValue(v.value, encrypted) };
}
