import { AppError, record, text, uuid } from './validation.js';
import { parsePage } from './workspace.js';

export const PDF_TOOL_PATH = '/v1/agent-tools/pdf';
export const PDF_TOOL_NAME = 'read_pdf_page';
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_ASSETS = 5;
export const MAX_ASSET_DESCRIPTION_LENGTH = 1000;
export type AssetAttachment = { id: string; name: string; size: number; type: string; description?: string };
export type AssetDetails = {
  id: string; name: string; size: number; type: string; description: string; channel_id: string; thread_id: string | null;
  uploader: string; shared_at: string; can_edit: boolean;
};
export type AssetUpload = { asset: AssetAttachment; upload: { url: string; fields: Record<string, string>; put_url?: string }; expires_at: string };
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

export const MAX_AGENT_PDF_PAGES = 8;
export const MAX_AGENT_PDF_CHARS = 16000;
export interface AgentPdfContent {
  kind: 'pdf';
  status: 'readable' | 'no_text' | 'out_of_range' | 'unavailable' | 'not_read';
  page_count: number | null;
  pages: { page: number; text: string; truncated: boolean }[];
}

function parsePdfContent(value: unknown): AgentPdfContent {
  const invalid = () => new AppError(400, 'invalid_asset_content');
  const c = record(value, ['kind', 'status', 'page_count', 'pages']);
  const total = c.page_count, status = c.status;
  if (status !== 'readable' && status !== 'no_text' && status !== 'out_of_range' && status !== 'unavailable' && status !== 'not_read') throw invalid();
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1) {
    if (total !== null || (status !== 'unavailable' && status !== 'not_read')) throw invalid();
  }
  if (!Array.isArray(c.pages) || c.pages.length > MAX_AGENT_PDF_PAGES) throw invalid();
  let remaining = MAX_AGENT_PDF_CHARS, previous = 0;
  const pages = c.pages.map(value => {
    const p = record(value, ['page', 'text', 'truncated']);
    if (typeof p.page !== 'number' || !Number.isSafeInteger(p.page) || p.page <= previous || total === null || p.page > total ||
        typeof p.text !== 'string' || p.text.length > remaining || typeof p.truncated !== 'boolean') throw invalid();
    remaining -= p.text.length;
    previous = p.page;
    return {page:p.page, text:p.text, truncated:p.truncated};
  });
  if ((status === 'readable' || status === 'no_text') !== Boolean(pages.length) ||
      (status === 'readable') !== pages.some(p => p.text.trim().length > 0)) throw invalid();
  return {kind:'pdf', page_count:total, status, pages};
}

/** A bounded rendering of each uploaded file for the current agent turn. */
export type AgentInputFile = AssetAttachment & {
  content: { kind: 'text'; text: string; truncated: boolean } | { kind: 'image'; webp: string } | { kind: 'file' } | AgentPdfContent;
};

export function parseAgentInputFiles(value: unknown): AgentInputFile[] {
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_ASSETS) throw new AppError(400, 'invalid_assets');
  return value.map(entry => {
    const v = record(entry, ['id','name','size','type','description','content']);
    const id = uuid(v.id);
    const file = { id, ...parseAssetInput({ name:v.name, size:v.size, type:v.type }), ...(v.description ? {description:text(v.description, MAX_ASSET_DESCRIPTION_LENGTH)} : {}) };
    if (v.content && typeof v.content === 'object' && 'kind' in v.content && v.content.kind === 'pdf')
      return {...file, content:parsePdfContent(v.content)};
    const c = record(v.content, ['kind','text','truncated','webp']);
    if (c.kind === 'file') return {...file, content:{kind:'file'}};
    if (c.kind === 'text' && typeof c.text === 'string' && c.text.length <= 16000 && typeof c.truncated === 'boolean')
      return {...file, content:{kind:'text',text:c.text,truncated:c.truncated}};
    if (c.kind === 'image' && typeof c.webp === 'string' && c.webp.length <= 200000 && /^[A-Za-z0-9+/]+={0,2}$/.test(c.webp))
      return {...file, content:{kind:'image',webp:c.webp}};
    throw new AppError(400, 'invalid_asset_content');
  });
}
