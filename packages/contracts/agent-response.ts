import { AppError, record, text } from './validation.js';
import { parseAgentMemoryUpdate, type AgentMemoryUpdate } from './memory-block.js';

export type AgentText = { id: string; text: string; status: 'streaming' | 'complete'; phase?: 'commentary' | 'final_answer' };
export type AgentTool = { id: string; name: string; arguments: string; result?: string; status: 'calling' | 'running' | 'completed' | 'interrupted' };
export type DocumentEditBlock = { id: string; type: 'document_edit'; title: string; original: string; replacement: string };
export type CarouselBlock = { id: string; type: 'carousel'; title: string; cards: { id: string; title: string; body: string }[] };
export type DataTableBlock = { id: string; type: 'data_table'; title: string; columns: string[]; rows: (string | number)[][] };
export type AgentComponent =
  | DataTableBlock
  | CarouselBlock
  | DocumentEditBlock
  | { id: string; type: 'alert'; level: 'warning' | 'error'; title: string; body?: string }
  | { id: string; type: 'card'; title: string; body: string }
  | { id: string; type: 'table'; title: string; columns: string[]; rows: string[][] };
export type AgentSessionView =
  | { key: string; name: string; type: 'html' | 'canvas'; content: string }
  | { key: string; name: string; type: 'blocks'; blocks: AgentComponent[] };
export type AgentSessionViewUpdate = {set: AgentSessionView} | {remove: string};
export type AgentSessionCodeContext = {
  repository?: { label: string; url?: string };
  base_branch?: string;
  head_branch?: string;
  pull_request?: { label: string; url: string };
};
export type AgentSessionOutputs = {
  views?: AgentSessionView[];
  context?: AgentSessionCodeContext;
  actions?: { label: string; url: string }[];
  preview?: { state: 'starting' | 'ready' | 'stopped'; label: string; url?: string; document?: string };
  files: { path: string; content: string; language?: string }[];
  changes: { path: string; patch: string }[];
};
export type AgentActivity = 'working' | 'thinking' | 'responding' | 'using_tools';
export type AgentResponseItem = { type: 'message' | 'tool' | 'component'; id: string };
export type AgentResponse = { messages: AgentText[]; tools: AgentTool[]; components: AgentComponent[]; items?: AgentResponseItem[]; activity?: AgentActivity; step?: string; outputs?: AgentSessionOutputs; memory?: AgentMemoryUpdate };

function resultLink(value: unknown): { label: string; url: string } {
  const item = record(value, ['label', 'url']);
  let url: URL;
  try { url = new URL(text(item.url, 2000)); } catch { throw new AppError(400, 'invalid_result_action'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new AppError(400, 'invalid_result_action');
  return { label: text(item.label, 64), url: url.href };
}

function codeContext(input: unknown): AgentSessionCodeContext {
  const fields = record(input, ['repository', 'base_branch', 'head_branch', 'pull_request']);
  const value: AgentSessionCodeContext = {};
  if (fields.repository !== undefined) {
    const repo = record(fields.repository, ['label', 'url']);
    value.repository = repo.url === undefined ? {label: text(repo.label, 64)} : resultLink(repo);
  }
  if (fields.base_branch !== undefined) value.base_branch = text(fields.base_branch, 200);
  if (fields.head_branch !== undefined) value.head_branch = text(fields.head_branch, 200);
  if (fields.pull_request !== undefined) value.pull_request = resultLink(fields.pull_request);
  return value;
}

function viewKey(value: unknown): string {
  const key = text(value, 128);
  if (!/^[a-z\d][a-z\d._/-]*$/i.test(key)) throw new AppError(400, 'invalid_view_key');
  return key;
}

function sessionView(input: unknown): AgentSessionView {
  const fields = record(input, ['key', 'name', 'type', 'content', 'blocks']);
  const key = viewKey(fields.key), name = text(fields.name, 64);
  if (fields.type === 'blocks' && fields.content === undefined) {
    return {key, name, type: 'blocks', blocks: unique(list(fields.blocks, 20, parseAgentComponent))};
  }
  if ((fields.type === 'html' || fields.type === 'canvas') && fields.blocks === undefined) {
    return {key, name, type: fields.type, content: string(fields.content, 32000)};
  }
  throw new AppError(400, 'invalid_session_view');
}

export function parseSessionViewUpdate(input: unknown): AgentSessionViewUpdate {
  const fields = record(input, ['set', 'remove']);
  if (fields.set === undefined) return {remove:viewKey(fields.remove)};
  if (fields.remove !== undefined || JSON.stringify(input).length > 32000) throw new AppError(400, 'invalid_session_view');
  return {set:sessionView(fields.set)};
}

export function updateSessionViews(views: AgentSessionView[], update: AgentSessionViewUpdate): AgentSessionView[] {
  if ('remove' in update) return views.filter(view => view.key !== update.remove);
  if (views.some(view => view.key === update.set.key)) return views.map(view => view.key === update.set.key ? update.set : view);
  if (views.length >= 8) throw new AppError(400, 'too_many_session_views');
  return [...views, update.set];
}

export function parseSessionOutputs(input: unknown): AgentSessionOutputs {
  const v = record(input, ['preview', 'files', 'changes', 'actions', 'views', 'context']);
  const files = list(v.files, 20, item => {
    const f = record(item, ['path', 'content', 'language']);
    return { path: text(f.path, 300), content: string(f.content, 32000), ...(f.language === undefined ? {} : { language: text(f.language, 50) }) };
  });
  const changes = list(v.changes, 20, item => {
    const f = record(item, ['path', 'patch']);
    return { path: text(f.path, 300), patch: string(f.patch, 32000) };
  });
  let preview: AgentSessionOutputs['preview'];
  if (v.preview !== undefined) {
    const p = record(v.preview, ['state', 'label', 'url', 'document']);
    if (!['starting', 'ready', 'stopped'].includes(p.state as string)) throw new AppError(400, 'invalid_preview');
    let url: URL | undefined;
    if (p.url !== undefined) {
      try { url = new URL(text(p.url, 2000)); } catch { throw new AppError(400, 'invalid_preview'); }
    }
    if (url && (url.protocol !== 'https:' || url.username || url.password)) throw new AppError(400, 'invalid_preview');
    preview = { state: p.state as NonNullable<typeof preview>['state'], label: text(p.label, 200), ...(url ? {url: url.href} : {}), ...(p.document === undefined ? {} : {document: string(p.document, 32000)}) };
  }
  const actions = v.actions === undefined ? undefined : list(v.actions, 8, resultLink);
  const context = v.context === undefined ? undefined : codeContext(v.context);
  const views = v.views === undefined ? undefined : list(v.views, 8, sessionView);
  if (views && new Set(views.map(view => view.key)).size !== views.length) throw new AppError(400, 'duplicate_view_key');
  return { ...(preview ? {preview} : {}), ...(actions ? {actions} : {}), ...(context ? {context} : {}),
    ...(views ? {views} : {}), files, changes };
}

function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new AppError(400, 'invalid_agent_response');
  return value;
}
function list<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new AppError(400, 'invalid_agent_response');
  return value.map(parse);
}
function unique<T extends { id: string }>(items: T[]): T[] {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new AppError(400, 'duplicate_response_id');
  return items;
}
export function parseAgentComponent(input: unknown): AgentComponent {
  if (input && typeof input === 'object' && 'type' in input && input.type === 'carousel') {
    const v = record(input, ['id', 'type', 'title', 'cards']);
    const cards = unique(list(v.cards, 10, value => {
      const card = record(value, ['id', 'title', 'body']);
      return { id: text(card.id, 128), title: text(card.title, 200), body: string(card.body, 8000) };
    }));
    if (!cards.length) throw new AppError(400, 'empty_carousel');
    return { type: 'carousel', id: text(v.id, 128), title: text(v.title, 200), cards };
  }
  if (input && typeof input === 'object' && 'type' in input && input.type === 'alert') {
    const v = record(input, ['id', 'type', 'level', 'title', 'body']);
    if (v.level !== 'warning' && v.level !== 'error') throw new AppError(400, 'invalid_alert_level');
    return { type: 'alert', id: text(v.id, 128), level: v.level, title: text(v.title, 200),
      ...(v.body === undefined ? {} : { body: string(v.body, 8000) }) };
  }
  if (input && typeof input === 'object' && 'type' in input && input.type === 'document_edit') {
    const v = record(input, ['id', 'type', 'title', 'original', 'replacement']);
    return { type: 'document_edit', id: text(v.id, 128), title: text(v.title, 200),
      original: text(v.original, 16000), replacement: text(v.replacement, 16000) };
  }
  const v = record(input, ['id', 'type', 'title', 'body', 'columns', 'rows']);
  const base = { id: text(v.id, 128), title: text(v.title, 200) };
  if (v.type === 'card' && v.columns === undefined && v.rows === undefined) return { ...base, type: 'card', body: string(v.body, 8000) };
  if ((v.type === 'table' || v.type === 'data_table') && v.body === undefined) {
    const columns = list(v.columns, 10, value => text(value, 100));
    if (!columns.length) throw new AppError(400, 'invalid_agent_response');
    function rows<T>(parseCell: (value: unknown) => T) {
      return list(v.rows, 100, row => {
        const cells = list(row, columns.length, parseCell);
        if (cells.length !== columns.length) throw new AppError(400, 'invalid_agent_response');
        return cells;
      });
    }
    if (v.type === 'data_table') {
      return { ...base, type: v.type, columns, rows: rows(value =>
        typeof value === 'number' && Number.isFinite(value) ? value : string(value, 1000)) };
    }
    return { ...base, type: v.type, columns, rows: rows(value => string(value, 1000)) };
  }
  throw new AppError(400, 'unsupported_agent_component');
}
// Accept fields already saved by the reverted turn presentation; project them into the original response shape.
export function parseAgentResponse(input: unknown): AgentResponse {
  const v = record(input, ['messages', 'tools', 'components', 'items', 'activity', 'step', 'outputs', 'metadata', 'memory']);
  if (v.activity !== undefined && !['working', 'thinking', 'responding', 'using_tools'].includes(v.activity as string)) throw new AppError(400, 'invalid_agent_activity');
  const messages = unique(list(v.messages, 30, (item): AgentText => {
    const m = record(item, ['id', 'text', 'status', 'phase']);
    if (m.status !== 'streaming' && m.status !== 'complete') throw new AppError(400, 'invalid_agent_response');
    return { id: text(m.id, 128), text: string(m.text, 16000), status: m.status, ...(m.phase === 'commentary' || m.phase === 'final_answer' ? { phase: m.phase } : {}) };
  }));
  const tools = unique(list(v.tools, 30, item => {
    const t = record(item, ['id', 'name', 'arguments', 'result', 'status', 'duration_ms', 'arguments_characters', 'result_characters']);
    if (!['calling', 'running', 'completed', 'interrupted', 'failed'].includes(t.status as string)) throw new AppError(400, 'invalid_agent_response');
    return { id: text(t.id, 128), name: text(t.name, 200), arguments: string(t.arguments, 8000),
      status: (t.status === 'failed' ? 'interrupted' : t.status) as AgentTool['status'], ...(t.result === undefined ? {} : { result: string(t.result, 16000) }) };
  }));
  const components = unique(list(v.components, 20, parseAgentComponent));
  let items: AgentResponseItem[] | undefined;
  if (v.items !== undefined) {
    const remaining = new Set([...messages.map(message => `message:${message.id}`), ...tools.map(tool => `tool:${tool.id}`)]);
    // Older snapshots order only messages and tools. Unlisted components follow those items.
    const componentIds = new Set(components.map(component => component.id));
    items = list(v.items, 80, value => {
      const item = record(value, ['type', 'id']);
      const id = text(item.id, 128);
      if (item.type === 'component') {
        if (!componentIds.delete(id)) throw new AppError(400, 'invalid_agent_response_order');
        return { type: 'component', id };
      }
      if (!['message', 'tool'].includes(item.type as string) || !remaining.delete(`${item.type}:${id}`)) throw new AppError(400, 'invalid_agent_response_order');
      return { type: item.type as AgentResponseItem['type'], id };
    });
    if (remaining.size) throw new AppError(400, 'incomplete_agent_response_order');
  }
  const result = { messages, tools, components, ...(items === undefined ? {} : { items }), ...(v.activity === undefined ? {} : { activity: v.activity as AgentActivity }), ...(v.step === undefined ? {} : { step: text(v.step, 200) }), ...(v.outputs === undefined ? {} : { outputs: parseSessionOutputs(v.outputs) }) };
  if (messages.map(message => message.text).join('\n\n').length > 16000 || JSON.stringify(result).length > 64000) throw new AppError(400, 'agent_response_too_large');
  // A bad memory block is dropped and never fails the turn. Its own size is bounded by parseAgentMemoryUpdate.
  if (v.memory !== undefined) {
    try { return { ...result, memory: parseAgentMemoryUpdate(v.memory) }; } catch { /* dropped */ }
  }
  return result;
}
