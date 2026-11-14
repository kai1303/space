import { createHash } from 'node:crypto';
import { HttpAgent } from '@ag-ui/client';
import { EventSchema } from '@ag-ui/core/schemas';
import { AppError, parseAgentComponent, parseAgentResponse, parseSessionOutputs, parseInvocation, type AgentConnector, type AgentEvent, type AgentResponse, type InvocationReceipt, type InvocationRequest } from '@space/contracts';

function eventId(execution: string, sequence: number) {
  const hex = createHash('sha256').update(`${execution}:ag-ui:${sequence}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Server-configured backend; no endpoint or credentials come from an agent or browser. */
export class AgUiConnector implements AgentConnector {
  readonly id = 'ag-ui';
  constructor(private readonly config: { url: string; token?: string }) {
    const url = new URL(config.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid AG_UI_URL');
  }
  async discover() { return { persistent_sessions: true, skills: ['ag-ui.run'], controls: { progress_stream: true } }; }
  async invoke(input: InvocationRequest, emit: (event: unknown) => Promise<void>, signal: AbortSignal): Promise<InvocationReceipt> {
    const request = parseInvocation(input);
    signal.throwIfAborted();
    const agent = new HttpAgent({ url: this.config.url, threadId: request.session_id,
      initialMessages: [{ id: request.execution_id, role: 'user', content: request.goal }],
      headers: { 'Idempotency-Key': request.execution_id, ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}) },
    });
    const response: AgentResponse = { messages: [], tools: [], components: [] };
    let sequence = 0, started = false, terminal = false;
    let failure: unknown;
    let archiveOnSuccess = false;
    const ignoredMessages = new Set<string>();
    const abort = () => agent.abortRun();
    signal.addEventListener('abort', abort, { once: true });
    const send = async (type: AgentEvent['type'], timestamp?: number, error?: string, lifecycle?: 'open'|'archive') => {
      signal.throwIfAborted();
      const snapshot = parseAgentResponse(response);
      const plain = snapshot.messages.map(message => message.text).join('\n\n');
      const text = error ?? (type === 'execution.completed'
        ? plain || snapshot.components.map(component => component.title).join('\n') || 'Agent run completed.'
        : snapshot.step ?? 'Working');
      await emit({ id: eventId(request.execution_id, ++sequence), schema_version: '1.0', execution_id: request.execution_id,
        sequence, type, occurred_at: new Date(timestamp ?? 0).toISOString(), payload: { text, response: snapshot, ...(lifecycle ? { session_lifecycle:lifecycle } : {}) } });
    };
    const finish = () => {
      response.messages.forEach(message => { message.status = 'complete'; });
      response.tools.forEach(tool => { if (tool.status !== 'completed') tool.status = 'interrupted'; });
      delete response.step;
    };
    try {
      await agent.runAgent({ runId: request.execution_id, forwardedProps: { ...(request.attachments ? {attachments:request.attachments} : {}), taskId: request.task_id, skill: request.skill, ...(request.context ? { context: request.context } : {}) } }, {
        onEvent: async ({ event: raw }) => {
          if (failure || signal.aborted) return { stopPropagation: true };
          try {
            if (terminal) return;
            if (JSON.stringify(raw).length > 32000) throw new AppError(400, 'ag_ui_event_too_large');
            const parsed = EventSchema.safeParse(raw);
            if (!parsed.success) throw new AppError(400, 'invalid_ag_ui_event');
            const event = parsed.data;
            // Subagent output needs separate attribution; never merge it into the parent's message IDs.
            if (event.subagentRunId) return;
            if (event.type === 'RUN_STARTED') {
              if (started || event.runId !== request.execution_id || event.threadId !== request.session_id) throw new AppError(409, 'invalid_ag_ui_run');
              started = true;
              await send('execution.started', event.timestamp);
              return;
            }
            if (!started) throw new AppError(409, 'ag_ui_run_not_started');
            switch (event.type) {
              case 'TEXT_MESSAGE_START':
                if (event.role !== 'assistant') { ignoredMessages.add(event.messageId); return; }
                if (response.messages.some(message => message.id === event.messageId)) throw new AppError(409, 'duplicate_response_id');
                response.messages.push({ id: event.messageId, text: '', status: 'streaming' });
                break;
              case 'TEXT_MESSAGE_CONTENT':
              case 'TEXT_MESSAGE_END': {
                if (ignoredMessages.has(event.messageId)) return;
                const message = response.messages.find(message => message.id === event.messageId);
                if (!message || message.status !== 'streaming') throw new AppError(409, 'invalid_ag_ui_message');
                if (event.type === 'TEXT_MESSAGE_CONTENT') message.text += event.delta;
                else message.status = 'complete';
                break;
              }
              case 'TOOL_CALL_START':
                if (response.tools.some(tool => tool.id === event.toolCallId)) throw new AppError(409, 'duplicate_response_id');
                response.tools.push({ id: event.toolCallId, name: event.toolCallName, arguments: '', status: 'calling' });
                break;
              case 'TOOL_CALL_ARGS':
              case 'TOOL_CALL_END':
              case 'TOOL_CALL_RESULT': {
                const tool = response.tools.find(tool => tool.id === event.toolCallId);
                if (!tool) throw new AppError(409, 'invalid_ag_ui_tool');
                if (event.type === 'TOOL_CALL_ARGS') tool.arguments += event.delta;
                else if (event.type === 'TOOL_CALL_END') tool.status = 'running';
                else {
                  tool.result = typeof event.content === 'string' ? event.content : event.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
                  tool.status = 'completed';
                }
                break;
              }
              case 'STEP_STARTED': response.step = event.stepName; break;
              case 'STEP_FINISHED': delete response.step; break;
              case 'CUSTOM': {
                if (event.name === 'space.session.outputs') {
                  response.outputs = parseSessionOutputs(event.value);
                  break;
                }
                if (event.name === 'space.session.open') {
                  await send('execution.progress', event.timestamp, undefined, 'open');
                  return;
                }
                if (event.name === 'space.session.archive') { archiveOnSuccess = true; return; }
                if (event.name !== 'space.ui') return;
                const component = parseAgentComponent(event.value);
                const index = response.components.findIndex(item => item.id === component.id);
                if (index === -1) response.components.push(component);
                else response.components[index] = component;
                break;
              }
              case 'RUN_FINISHED': {
                if (event.runId !== request.execution_id || event.threadId !== request.session_id) throw new AppError(409, 'invalid_ag_ui_run');
                finish();
                const unsupported = event.outcome && event.outcome.type !== 'success';
                await send(unsupported ? 'execution.failed' : 'execution.completed', event.timestamp,
                  unsupported ? 'This agent requested an interaction that Space does not support yet.' : undefined, archiveOnSuccess && !unsupported ? 'archive' : undefined);
                terminal = true;
                return;
              }
              case 'RUN_ERROR':
                finish();
                await send('execution.failed', event.timestamp, 'The agent backend reported an error.');
                terminal = true;
                return;
              default: return; // Raw state, reasoning and unknown custom payloads are not response components.
            }
            await send('execution.progress', event.timestamp);
          } catch (error) {
            // The SDK logs and swallows subscriber exceptions; explicitly abort and rethrow after the run.
            failure = error;
            agent.abortRun();
            return { stopPropagation: true };
          }
        },
      });
      if (failure) throw failure;
      signal.throwIfAborted();
      if (!terminal) throw new AppError(502, 'missing_terminal_event');
      return { external_execution_id: request.execution_id, status: 'completed' };
    } finally { signal.removeEventListener('abort', abort); agent.abortRun(); }
  }
}
