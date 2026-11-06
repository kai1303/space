import { AppError, record, text } from './validation.js';
export interface OutboundTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface OutboundGrant {
  installation_id: string;
  tools: string[];
}
export interface OutboundConnection {
  id: string;
  name: string;
  url: string;
  auth_type: 'bearer' | 'none';
  enabled: boolean;
  revision: number;
  status: 'untested' | 'ready' | 'error';
  tools: OutboundTool[];
  grants: OutboundGrant[];
  created_at: string;
}
export interface OutboundAgent {
  id: string;
  name: string;
  workspace_name: string;
}
export interface OutboundCall {
  id: string;
  connection_name: string;
  tool_name: string;
  agent_name: string;
  status: 'pending' | 'succeeded' | 'failed' | 'uncertain';
  created_at: string;
  duration_ms: number | null;
}
export interface OutboundAccess {
  url: string;
  token: string;
  tools: string[];
}
export function outboundUrl(raw: unknown) {
  let url: URL;
  try {
    url = new URL(text(raw, 2000));
  } catch {
    throw new AppError(400, 'invalid_mcp_url');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new AppError(400, 'invalid_mcp_url');
  return url.href;
}
export function parseOutboundConnection(raw: unknown) {
  const v = record(raw, ['name', 'url', 'auth_type', 'token']);
  if (v.auth_type !== 'bearer' && v.auth_type !== 'none') throw new AppError(400, 'invalid_mcp_auth');
  const token = v.token === undefined ? undefined : text(v.token, 4096);
  if ((v.auth_type === 'bearer' && !token) || (v.auth_type === 'none' && token) || (token && /[\r\n]/.test(token)))
    throw new AppError(400, 'invalid_mcp_token');
  return {
    name: text(v.name, 100).trim(),
    url: outboundUrl(v.url),
    auth_type: v.auth_type,
    ...(token ? { token } : {}),
  };
}
export function parseOutboundTools(raw: unknown): OutboundTool[] {
  if (!Array.isArray(raw) || raw.length > 100 || new TextEncoder().encode(JSON.stringify(raw)).byteLength > 262144)
    throw new AppError(400, 'invalid_mcp_catalog');
  const tools = raw.map((value) => {
    if (!value || typeof value !== 'object') throw new AppError(400, 'invalid_mcp_tool');
    const { name, description, inputSchema } = value;
    if (
      typeof name !== 'string' ||
      !/^[-a-zA-Z0-9_.]{1,64}$/.test(name) ||
      !inputSchema ||
      typeof inputSchema !== 'object' ||
      Array.isArray(inputSchema) ||
      inputSchema.type !== 'object'
    )
      throw new AppError(400, 'invalid_mcp_tool');
    if (description !== undefined && (typeof description !== 'string' || description.length > 4000))
      throw new AppError(400, 'invalid_mcp_tool');
    return { name, ...(description === undefined ? {} : { description }), inputSchema };
  });
  if (new Set(tools.map((t) => t.name)).size !== tools.length) throw new AppError(400, 'duplicate_mcp_tool');
  return tools;
}
