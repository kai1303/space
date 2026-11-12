import { AppError, record, text, uuid } from './validation.js';
import { parsePage } from './workspace.js';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_ASSETS = 5;
export const MAX_ASSET_DESCRIPTION_LENGTH = 1000;
export type AssetAttachment = { id: string; name: string; size: number; type: string; description?: string };
export type AssetDetails = {
  id: string; name: string; size: number; type: string; description: string; channel_id: string; thread_id: string | null;
  uploader: string; shared_at: string; can_edit: boolean;
};
export type AssetUpload = { asset: AssetAttachment; upload: { url: string; fields: Record<string, string> }; expires_at: string };
export type AssetPreview =
  | { kind: 'image'; mime: 'image/webp' | 'image/gif'; width: number; height: number }
  | { kind: 'office'; fileType: 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' }
  | { kind: 'pdf'; mime: 'application/pdf'; thumbnail?: boolean }
  | { kind: 'audio' | 'video'; mime: string }
  | { kind: 'text'; text: string; language: string; truncated: boolean }
  | { kind: 'unsupported'; reason: string };

export type ChannelFile = AssetAttachment & {
  preview_kind: AssetPreview['kind'] | 'file';
  message_id: string;
  thread_id: string;
  shared_at: string;
  uploader: { id: string; name: string };
};
export type AssetListQuery = {
  q: string;
  kind: 'all' | 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'other';
  sort: 'newest' | 'oldest';
  limit: number;
  after?: string;
};
export function parseAssetListQuery(input: unknown): AssetListQuery {
  const v = record(input, ['q', 'kind', 'sort', 'limit', 'after']);
  const q = v.q === undefined ? '' : v.q, kind = v.kind === undefined ? 'all' : v.kind, sort = v.sort === undefined ? 'newest' : v.sort;
  if (typeof q !== 'string' || q.length > 255 || q.includes('\0')) throw new AppError(400, 'invalid_query');
  if (!['all', 'image', 'pdf', 'text', 'audio', 'video', 'other'].includes(kind as string)) throw new AppError(400, 'invalid_kind');
  if (sort !== 'newest' && sort !== 'oldest') throw new AppError(400, 'invalid_sort');
  if (v.limit !== undefined && typeof v.limit !== 'string') throw new AppError(400, 'invalid_limit');
  return { q, kind: kind as AssetListQuery['kind'], sort, ...parsePage({ limit: v.limit === undefined ? '30' : v.limit, ...(v.after === undefined ? {} : { after: v.after }) }) };
}

export function parseAssetName(value: unknown) {
  const name = text(value, 255).trim();
  if (/[\x00-\x1f\x7f/\\]/.test(name) || name === '.' || name === '..') throw new AppError(400, 'invalid_filename');
  return name;
}

export function parseAssetInput(input: unknown) {
  const v = record(input, ['name', 'size', 'type']);
  const name = parseAssetName(v.name);
  if (!Number.isSafeInteger(v.size) || (v.size as number) < 1 || (v.size as number) > MAX_ASSET_BYTES) throw new AppError(400, 'invalid_file_size');
  const type = v.type === '' || v.type === undefined ? 'application/octet-stream' : text(v.type, 127).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) throw new AppError(400, 'invalid_file_type');
  return { name, size: v.size as number, type };
}

export function parseAssetIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_MESSAGE_ASSETS) throw new AppError(400, 'invalid_assets');
  const ids = input.map(uuid);
  if (new Set(ids).size !== ids.length) throw new AppError(400, 'invalid_assets');
  return ids;
}

export function parseAssetDescriptions(input: unknown, ids: string[]): Record<string, string> | undefined {
  const values = record(input, ids);
  const descriptions: Record<string, string> = {};
  // Canonical attachment order makes retry hashes independent of JSON key order.
  for (const id of ids) if (Object.hasOwn(values, id)) {
    const value = values[id];
    if (typeof value !== 'string' || value.length > MAX_ASSET_DESCRIPTION_LENGTH || value.includes('\0')) throw new AppError(400, 'invalid_asset_description');
    if (value.trim()) descriptions[id] = value.trim();
  }
  return Object.keys(descriptions).length ? descriptions : undefined;
}
