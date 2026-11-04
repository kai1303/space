import { parseAgentResponse, type AgentActivity, type AgentText, type AgentTool, type AgentResponseItem } from '@space/contracts';

// Accumulated snapshots share the existing backpressure and durable event path.
export class AgentProgress {
  activity: AgentActivity = 'working';
  readonly tools = new Map<string, AgentTool>();
  private readonly items: AgentResponseItem[] = [];
  message(id: string) {
    if (!id || id.length > 128 || id.includes('\0')) throw new Error('Invalid message identity.');
    if (this.items.some(item => item.type === 'message' && item.id === id)) return;
    if (this.items.filter(item => item.type === 'message').length >= 30) throw new Error('Too many messages.');
    this.items.push({ type: 'message', id });
  }
  setActivity(activity: AgentActivity) {
    this.activity = [...this.tools.values()].some(tool => tool.status === 'running' || tool.status === 'calling') ? 'using_tools' : activity;
  }
  tool(id: unknown, name: unknown, args: unknown, status: AgentTool['status'], result?: unknown) {
    if (typeof id !== 'string' || !id || id.length > 128 || typeof name !== 'string' || !name || name.length > 200) throw new Error('Invalid tool identity.');
    if (!this.tools.has(id) && this.tools.size >= 30) throw new Error('Too many tool calls.');
    if (!this.tools.has(id)) this.items.push({ type: 'tool', id });
    const printable = (value: unknown, limit: number) => (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replaceAll('\0', '').slice(0, limit);
    this.tools.set(id, { id, name, arguments: printable(args, 8000), status, ...(result === undefined ? {} : { result: printable(toolResult(result), 16000) }) });
    this.setActivity('working');
  }
  snapshot(messages: AgentText[], terminal = false) {
    for (const message of messages) this.message(message.id);
    const messageIds = new Set(messages.map(message => message.id));
    const items = this.items.filter(item => item.type === 'tool' ? this.tools.has(item.id) : messageIds.has(item.id));
    const originals = [...this.tools.values()];
    const snapshot = parseAgentResponse({ messages, tools: originals.map(tool => ({ ...tool, arguments: '', ...(tool.result === undefined ? {} : { result: '' }), ...(terminal && ['calling', 'running'].includes(tool.status) ? { status: 'interrupted' } : {}) })), components: [], items, ...(!terminal ? { activity: this.activity } : {}) });
    let remaining = 64000 - JSON.stringify(snapshot).length;
    // Keep recent tool details first; many file reads must not fail a valid turn.
    for (let index = originals.length - 1; index >= 0; index--) {
      for (const field of ['arguments', 'result'] as const) {
        const original = originals[index]![field];
        if (original === undefined) continue;
        let value = original;
        if (JSON.stringify(value).length - 2 > remaining) {
          const suffix = '… [truncated]';
          let low = 0, high = Math.min(original.length, (field === 'arguments' ? 8000 : 16000) - suffix.length);
          if (remaining < suffix.length) value = '';
          else {
            while (low < high) {
              const middle = Math.ceil((low + high) / 2);
              if (JSON.stringify(original.slice(0, middle) + suffix).length - 2 <= remaining) low = middle; else high = middle - 1;
            }
            value = original.slice(0, low) + suffix;
          }
        }
        snapshot.tools[index]![field] = value;
        remaining -= JSON.stringify(value).length - 2;
      }
    }
    return parseAgentResponse(snapshot);
  }
}


function toolResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const content = value.flatMap(item => item?.type === 'text' ? [item.text] : item?.type === 'content' && item.content?.type === 'text' ? [item.content.text] : []);
    return content.length ? content.join('\n') : value;
  }
  const output = value as { content?: unknown[]; response?: unknown; message?: unknown };
  if (Array.isArray(output.content)) return toolResult(output.content);
  if (typeof output.response === 'string') return output.response;
  if (typeof output.message === 'string') return output.message;
  return value;
}
