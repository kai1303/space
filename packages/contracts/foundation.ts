import { parseSidekickContext } from './sidekick.js';
import { AppError, record, text, uuid } from './validation.js';
import { parseAgentMemoryContext } from './memory.js';
import { parseThreadContext } from './thread-context.js';
import type { AgentCapabilities, AgentSession, ControlFeature, Execution, InvocationRequest } from './index.js';
export interface DefinitionInput { name: string; capabilities: AgentCapabilities }
export interface InstallationInput { workspace_id: string; definition_id: string; connector_id: string }
export interface GrantInput { channel_id: string; skill: string }
export interface AgentGrant extends GrantInput { workspace_id: string; installation_id: string }
const controls: ControlFeature[] = ['active_steer', 'queued_followup', 'cancel', 'pause', 'resume', 'progress_stream', 'input_request'];
export function parseCapabilities(value: unknown): AgentCapabilities {
  const v = record(value, ['skills', 'controls', 'persistent_sessions']);
  if (!Array.isArray(v.skills) || v.skills.length > 100) throw new AppError(400, 'invalid_skills');
  const skills = v.skills.map(skill => text(skill, 80));
  if (new Set(skills).size !== skills.length) throw new AppError(400, 'duplicate_skill');
  const flags = record(v.controls, controls);
  if (Object.values(flags).some(flag => typeof flag !== 'boolean')) throw new AppError(400, 'invalid_controls');
  if (v.persistent_sessions !== undefined && typeof v.persistent_sessions !== 'boolean') throw new AppError(400, 'invalid_persistent_sessions');
  return { skills, controls: { ...flags } as AgentCapabilities['controls'], ...(v.persistent_sessions === undefined ? {} : { persistent_sessions: v.persistent_sessions }) };
}
export function parseDefinitionInput(value: unknown): DefinitionInput {
  const v = record(value, ['name', 'capabilities']);
  return { name: text(v.name, 160), capabilities: parseCapabilities(v.capabilities) };
}
export function parseInstallationInput(value: unknown): InstallationInput {
  const v = record(value, ['workspace_id', 'definition_id', 'connector_id']);
  const connector_id = text(v.connector_id, 80);
  if (!/^[a-z][a-z0-9._-]*$/.test(connector_id)) throw new AppError(400, 'invalid_connector_id');
  return { workspace_id: uuid(v.workspace_id), definition_id: uuid(v.definition_id), connector_id };
}
export function parseGrantInput(value: unknown): GrantInput {
  const v = record(value, ['channel_id', 'skill']);
  return { channel_id: uuid(v.channel_id), skill: text(v.skill, 80) };
}
export function parseSession(value: unknown): AgentSession {
  const v = record(value, ['id', 'workspace_id', 'installation_id', 'origin_thread_id']);
  return { id: uuid(v.id), workspace_id: uuid(v.workspace_id), installation_id: uuid(v.installation_id), origin_thread_id: uuid(v.origin_thread_id) };
}
export function parseExecution(value: unknown): Execution {
  const v = record(value, ['id', 'task_id', 'workspace_id', 'installation_id', 'session_id', 'status', 'last_sequence']);
  if (!['queued', 'running', 'completed', 'failed'].includes(v.status as string) || !Number.isSafeInteger(v.last_sequence) || (v.last_sequence as number) < 0) throw new AppError(400, 'invalid_execution');
  return { id: uuid(v.id), task_id: uuid(v.task_id), workspace_id: uuid(v.workspace_id), installation_id: uuid(v.installation_id), session_id: uuid(v.session_id), status: v.status as Execution['status'], last_sequence: v.last_sequence as number };
}
export function parseInvocation(value: unknown): InvocationRequest {
  const v = record(value, ['schema_version', 'task_id', 'execution_id', 'session_id', 'idempotency_key', 'goal', 'skill', 'context', 'persistent_session', 'outbound']);
  if (v.schema_version !== '1.0') throw new AppError(400, 'unsupported_schema_version');
  const execution_id = uuid(v.execution_id);
  if (uuid(v.idempotency_key) !== execution_id) throw new AppError(400, 'invalid_idempotency_key');
  let context:InvocationRequest['context'];
  if (v.context !== undefined) {
    const ctx = record(v.context, ['thread_id', 'messages', 'working_memory', 'channel_memory', 'handoff']);
    if (!Array.isArray(ctx.messages) || ctx.messages.length > 16) throw new AppError(400, 'invalid_context');
    const working_memory = ctx.working_memory === undefined ? undefined : parseThreadContext(ctx.working_memory);
    if (working_memory && working_memory.thread_id !== uuid(ctx.thread_id)) throw new AppError(400, 'invalid_context_thread');
    context = { ...(ctx.handoff === undefined ? {} : {handoff: parseSidekickContext(ctx.handoff)}), ...(ctx.channel_memory === undefined ? {} : { channel_memory: parseAgentMemoryContext(ctx.channel_memory) }), ...(working_memory ? { working_memory } : {}), thread_id: uuid(ctx.thread_id), messages: ctx.messages.map(raw => {
      const m = record(raw, ['id', 'text', 'author_type']);
      if (m.author_type !== 'human' && m.author_type !== 'agent') throw new AppError(400, 'invalid_context');
      return { id: uuid(m.id), text: text(m.text, 1000), author_type: m.author_type };
    }) };
  }
  let persistent_session: InvocationRequest['persistent_session'];
  if (v.persistent_session !== undefined) {
    const persistent = record(v.persistent_session, ['resume']);
    if (typeof persistent.resume !== 'boolean') throw new AppError(400, 'invalid_persistent_session');
    persistent_session = { resume: persistent.resume };
  }
  let outbound: InvocationRequest['outbound'];
  if (v.outbound !== undefined) {
    const access = record(v.outbound, ['url', 'token', 'tools']);
    let url: URL;
    try { url = new URL(text(access.url, 2000)); } catch { throw new AppError(400, 'invalid_outbound_url'); }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new AppError(400, 'invalid_outbound_url');
    const token = text(access.token, 4096);
    if (/\s/.test(token)) throw new AppError(400, 'invalid_outbound_token');
    // A turn can use 20 personal and 20 workspace servers with 100 tools each.
    if (!Array.isArray(access.tools) || access.tools.length > 4000 || access.tools.some(name => typeof name !== 'string' || !/^[-a-zA-Z0-9_.]{1,128}$/.test(name)) || new Set(access.tools).size !== access.tools.length) throw new AppError(400, 'invalid_outbound_tools');
    outbound = { url: url.href, token, tools: access.tools };
  }
  return { ...(outbound ? { outbound } : {}), ...(persistent_session ? { persistent_session } : {}), ...(context?{context}:{}), schema_version: '1.0', task_id: uuid(v.task_id), execution_id, session_id: uuid(v.session_id), idempotency_key: execution_id, goal: text(v.goal), skill: text(v.skill, 80) };
}
