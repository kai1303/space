import { parseRichDocument, type RichDocument } from './rich-text.js';
import { AppError, record, text, uuid } from './validation.js';

export interface HubMessage {
  id: string; channel_id: string; channel_name: string; thread_id: string;
  text: string; author_name: string; created_at: string; reply_count: number;
  document?: RichDocument | null;
}
export interface HubFile {
  id: string; channel_id: string; channel_name: string; message_id: string;
  uploader_id: string; uploader_name: string; starred: boolean; last_viewed_at: string | null;
  filename: string; content_type: string; byte_size: number; preview_kind: string; created_at: string;
}
export interface HubTodo {
  id: string; title: string; completed: boolean; created_at: string; updated_at: string;
  document: RichDocument | null; remind_at: string | null; reminder_fired_at: string | null;
  archived: boolean; deleted: boolean; channel_id: string | null; message_id: string | null;
  external?: {name: string; external_id: string; revision: string; url: string | null} | null;
}
export type HubTodoInput = Partial<Pick<HubTodo, 'title' | 'completed' | 'document' | 'remind_at' | 'archived' | 'deleted' | 'channel_id' | 'message_id'>> & {create_only: boolean; expected_updated_at?: string};
function todoDate(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value.slice(0,10)) throw new AppError(400,code);
  return value;
}
export function parseHubToggle(input: unknown): { active: boolean } {
  const v = record(input, ['active']);
  if (typeof v.active !== 'boolean') throw new AppError(400, 'invalid_active');
  return { active: v.active };
}
export function parseHubTodo(input: unknown): HubTodoInput {
  const v = record(input, ['title', 'completed', 'create_only', 'document', 'remind_at', 'archived', 'deleted', 'channel_id', 'message_id', 'expected_updated_at']);
  const result: HubTodoInput = {create_only: false};
  for (const key of ['completed','archived','deleted','create_only'] as const) {
    if (v[key] !== undefined) { if(typeof v[key] !== 'boolean') throw new AppError(400,`invalid_${key}`); result[key]=v[key]; }
  }
  if(v.title !== undefined) result.title=text(v.title,500).trim();
  if(v.document !== undefined) result.document=v.document === null ? null : parseRichDocument(v.document);
  if(v.remind_at !== undefined) result.remind_at=v.remind_at === null ? null : todoDate(v.remind_at,'invalid_remind_at');
  if(v.expected_updated_at !== undefined) result.expected_updated_at=todoDate(v.expected_updated_at,'invalid_expected_updated_at');
  if(v.channel_id !== undefined || v.message_id !== undefined) {
    if(v.channel_id == null || v.message_id == null) throw new AppError(400,'invalid_todo_source');
    result.channel_id=uuid(v.channel_id); result.message_id=uuid(v.message_id);
  }
  if(!['title','completed','document','remind_at','archived','deleted','channel_id'].some(key=>v[key]!==undefined)) throw new AppError(400,'empty_todo_update');
  return result;
}

export const HUB_FILE_KINDS = ['image', 'pdf', 'text', 'audio', 'video', 'other'] as const;
export type HubFileKind = typeof HUB_FILE_KINDS[number];

export function parseHubFileQuery(input: unknown) {
  const v = record(input, ['after', 'limit', 'q', 'kind', 'kinds', 'sort', 'ownership', 'from', 'channel', 'since', 'before', 'starred']);
  const choice = <T extends string>(key: string, choices: readonly T[], fallback: T): T => {
    if (v[key] === undefined) return fallback;
    if (typeof v[key] !== 'string' || !choices.includes(v[key] as T)) throw new AppError(400, `invalid_${key}`);
    return v[key] as T;
  };
  const date = (key: string) => {
    if (v[key] === undefined) return undefined;
    const value = text(v[key], 30);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value.slice(0,10)) throw new AppError(400, `invalid_${key}`);
    return value;
  };
  const since = date('since'), before = date('before');
  if (since && before && Date.parse(since) >= Date.parse(before)) throw new AppError(400, 'invalid_date_range');
  const kind = choice('kind', ['all', ...HUB_FILE_KINDS], 'all');
  let kinds: readonly HubFileKind[] = kind === 'all' ? HUB_FILE_KINDS : [kind];
  if (v.kinds !== undefined) {
    if (v.kind !== undefined || typeof v.kinds !== 'string' || v.kinds.length > 64) throw new AppError(400, 'invalid_kinds');
    const selected = v.kinds === '' ? [] : v.kinds.split(',');
    if (selected.length > HUB_FILE_KINDS.length || new Set(selected).size !== selected.length || selected.some(item => !HUB_FILE_KINDS.includes(item as HubFileKind))) throw new AppError(400, 'invalid_kinds');
    kinds = selected as HubFileKind[];
  }
  return { after: v.after, limit: v.limit, q: v.q === undefined || v.q === '' ? '' : text(v.q, 255).trim(),
    kinds,
    sort: choice('sort', ['newest', 'oldest', 'recent'], 'newest'),
    ownership: choice('ownership', ['all', 'created', 'shared'], 'all'),
    starred: choice('starred', ['true', 'false'], 'false') === 'true',
    from: v.from === undefined ? undefined : uuid(v.from), channel: v.channel === undefined ? undefined : uuid(v.channel), since, before };
}
