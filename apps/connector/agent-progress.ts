import { extractMemoryBlock, visibleText, parseAgentResponse, type AgentActivity, type AgentText, type AgentTool, type AgentResponseItem } from '@space/contracts';

// Accumulated snapshots share the existing backpressure and durable event path.
export class AgentProgress {
  private readonly pullRequestAction?: {label: string; url: string};
  constructor(private readonly rolling = false, pullRequestUrl = process.env.SPACE_PULL_REQUEST_URL) {
    if (!rolling || !pullRequestUrl) return;
    const url = new URL(pullRequestUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.length > 2000)
      throw new Error('SPACE_PULL_REQUEST_URL requires an HTTPS URL without credentials, query, or fragment.');
    this.pullRequestAction = {label: 'Open pull request page', url: url.href};
  }
  activity: AgentActivity = 'working';
  readonly tools = new Map<string, AgentTool>();
  private readonly items: AgentResponseItem[] = [];
  private readonly changes = new Map<string, string>();
  change(path: unknown, patch: unknown) {
    if (typeof path !== 'string' || !path || path.length > 300 || path.includes('\0') || typeof patch !== 'string' || !patch || patch.includes('\0')) return;
    if (!this.changes.has(path) && this.changes.size >= 20) this.changes.delete(this.changes.keys().next().value!);
    this.changes.set(path, patch.length > 32000 ? `${patch.slice(0, 31970)}\n… [truncated]` : patch);
  }
  message(id: string) {
    if (!id || id.length > 128 || id.includes('\0')) throw new Error('Invalid message identity.');
    if (this.items.some(item => item.type === 'message' && item.id === id)) return;
    if (this.items.filter(item => item.type === 'message').length >= 30) {
      if (!this.rolling) throw new Error('Too many messages.');
      this.items.splice(this.items.findIndex(item => item.type === 'message'), 1);
    }
    this.items.push({ type: 'message', id });
  }
  setActivity(activity: AgentActivity) {
    this.activity = [...this.tools.values()].some(tool => tool.status === 'running' || tool.status === 'calling') ? 'using_tools' : activity;
  }
  tool(id: unknown, name: unknown, args: unknown, status: AgentTool['status'], result?: unknown) {
    if (typeof id !== 'string' || !id || id.length > 128 || typeof name !== 'string' || !name || name.length > 200) throw new Error('Invalid tool identity.');
    if (!this.tools.has(id) && this.tools.size >= 30) {
      if (!this.rolling) throw new Error('Too many tool calls.');
      const oldest = this.tools.keys().next().value!;
      this.tools.delete(oldest);
      const index = this.items.findIndex(item => item.type === 'tool' && item.id === oldest);
      if (index >= 0) this.items.splice(index, 1);
    }
    if (!this.tools.has(id)) this.items.push({ type: 'tool', id });
    const printable = (value: unknown, limit: number) => (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replaceAll('\0', '').slice(0, limit);
    this.tools.set(id, { id, name, arguments: printable(args, 8000), status, ...(result === undefined ? {} : { result: printable(toolResult(result), 16000) }) });
    this.setActivity('working');
  }
  snapshot(messages: AgentText[], terminal = false) {
    // The turn-end memory block is for Space only: hide it from people and attach it when final.
    const memory = terminal ? extractMemoryBlock(messages.map(m => m.text).join('\n\n')) : undefined;
    messages = messages.map(m => ({ ...m, text: visibleText(m.text, terminal) }));
    for (const message of messages) this.message(message.id);
    const messageIds = new Set(messages.map(message => message.id));
    const items = this.items.filter(item => item.type === 'tool' ? this.tools.has(item.id) : messageIds.has(item.id));
    const originals = [...this.tools.values()];
    const snapshot = parseAgentResponse({ messages, tools: originals.map(tool => ({ ...tool, arguments: '', ...(tool.result === undefined ? {} : { result: '' }), ...(terminal && ['calling', 'running'].includes(tool.status) ? { status: 'interrupted' } : {}) })), components: [], items, ...(this.changes.size ? { outputs: { ...(terminal && this.pullRequestAction ? { actions: [this.pullRequestAction] } : {}), files: [], changes: [...this.changes.keys()].map(path => ({ path, patch: '' })) } } : {}), ...(!terminal ? { activity: this.activity } : {}), ...(memory ? { memory } : {}) });
    let remaining = 64000 - JSON.stringify(snapshot).length;
    if (snapshot.outputs) {
      let patchBudget = Math.min(32000, remaining);
      for (let index = snapshot.outputs.changes.length - 1; index >= 0; index--) {
        const entry = snapshot.outputs.changes[index]!, original = this.changes.get(entry.path)!;
        let value = original;
        if (JSON.stringify(value).length - 2 > patchBudget) {
          let low = 0, high = original.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (JSON.stringify(original.slice(0, middle) + '… [truncated]').length - 2 <= patchBudget) low = middle; else high = middle - 1;
          }
          value = patchBudget >= 13 ? original.slice(0, low) + '… [truncated]' : '';
        }
        entry.patch = value;
        const size = JSON.stringify(value).length - 2;
        remaining -= size; patchBudget -= size;
      }
    }
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
