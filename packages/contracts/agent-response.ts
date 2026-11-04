import { AppError, record, text } from './validation.js';

export type AgentText = { id: string; text: string; status: 'streaming' | 'complete' };
export type AgentTool = { id: string; name: string; arguments: string; result?: string; status: 'calling' | 'running' | 'completed' | 'interrupted' };
export type AgentComponent =
  | { id: string; type: 'card'; title: string; body: string }
  | { id: string; type: 'table'; title: string; columns: string[]; rows: string[][] };
export type AgentSessionOutputs = {
  preview?: { state: 'starting' | 'ready' | 'stopped'; label: string; url?: string; document?: string };
  files: { path: string; content: string; language?: string }[];
  changes: { path: string; patch: string }[];
};
export type AgentActivity = 'working' | 'thinking' | 'responding' | 'using_tools';
export type AgentResponseItem = { type: 'message' | 'tool'; id: string };
export type AgentResponse = { messages: AgentText[]; tools: AgentTool[]; components: AgentComponent[]; items?: AgentResponseItem[]; activity?: AgentActivity; step?: string; outputs?: AgentSessionOutputs };

function parseOutputs(input: unknown): AgentSessionOutputs {
  const v = record(input, ['preview', 'files', 'changes']);
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
  return { ...(preview ? {preview} : {}), files, changes };
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
  const v = record(input, ['id', 'type', 'title', 'body', 'columns', 'rows']);
  const base = { id: text(v.id, 128), title: text(v.title, 200) };
  if (v.type === 'card' && v.columns === undefined && v.rows === undefined) return { ...base, type: 'card', body: string(v.body, 8000) };
  if (v.type === 'table' && v.body === undefined) {
    const columns = list(v.columns, 10, value => text(value, 100));
    if (!columns.length) throw new AppError(400, 'invalid_agent_response');
    const rows = list(v.rows, 100, row => list(row, columns.length, value => string(value, 1000)));
    if (rows.some(row => row.length !== columns.length)) throw new AppError(400, 'invalid_agent_response');
    return { ...base, type: 'table', columns, rows };
  }
  throw new AppError(400, 'unsupported_agent_component');
}
export function parseAgentResponse(input: unknown): AgentResponse {
  const v = record(input, ['messages', 'tools', 'components', 'items', 'activity', 'step', 'outputs']);
  if (v.activity !== undefined && !['working', 'thinking', 'responding', 'using_tools'].includes(v.activity as string)) throw new AppError(400, 'invalid_agent_activity');
  const messages = unique(list(v.messages, 30, (item): AgentText => {
    const m = record(item, ['id', 'text', 'status']);
    if (m.status !== 'streaming' && m.status !== 'complete') throw new AppError(400, 'invalid_agent_response');
    return { id: text(m.id, 128), text: string(m.text, 16000), status: m.status };
  }));
  const tools = unique(list(v.tools, 30, item => {
    const t = record(item, ['id', 'name', 'arguments', 'result', 'status']);
    if (!['calling', 'running', 'completed', 'interrupted'].includes(t.status as string)) throw new AppError(400, 'invalid_agent_response');
    return { id: text(t.id, 128), name: text(t.name, 200), arguments: string(t.arguments, 8000),
      status: t.status as AgentTool['status'], ...(t.result === undefined ? {} : { result: string(t.result, 16000) }) };
  }));
  const components = unique(list(v.components, 20, parseAgentComponent));
  let items: AgentResponseItem[] | undefined;
  if (v.items !== undefined) {
    const remaining = new Set([...messages.map(message => `message:${message.id}`), ...tools.map(tool => `tool:${tool.id}`)]);
    items = list(v.items, 60, value => {
      const item = record(value, ['type', 'id']);
      const id = text(item.id, 128);
      if (!['message', 'tool'].includes(item.type as string) || !remaining.delete(`${item.type}:${id}`)) throw new AppError(400, 'invalid_agent_response_order');
      return { type: item.type as AgentResponseItem['type'], id };
    });
    if (remaining.size) throw new AppError(400, 'incomplete_agent_response_order');
  }
  const result = { messages, tools, components, ...(items === undefined ? {} : { items }), ...(v.activity === undefined ? {} : { activity: v.activity as AgentActivity }), ...(v.step === undefined ? {} : { step: text(v.step, 200) }), ...(v.outputs === undefined ? {} : { outputs: parseOutputs(v.outputs) }) };
  if (messages.map(message => message.text).join('\n\n').length > 16000 || JSON.stringify(result).length > 64000) throw new AppError(400, 'agent_response_too_large');
  return result;
}
