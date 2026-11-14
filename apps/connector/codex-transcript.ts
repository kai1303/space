import type { AgentText, AgentTool, TranscriptChunk, TranscriptItem } from '@space/contracts';

export const codexFrameLimit = 16 * 1024 * 1024;
type Content = AgentText | (AgentTool & { metadata?: Record<string, unknown>; output?: string });
type Entry = { item: TranscriptItem; content: Content; size: number };

// Only unfinished items need assembling. Final items go onto the ordered, acknowledged event stream.
export class CodexTranscript {
  private position = 0;
  private open = new Map<string, Entry>();
  private buffered = 0;

  constructor(private write: (chunk: TranscriptChunk) => void, private visible: (text: string, final: boolean) => string) {}

  private entry(kind: TranscriptItem['kind'], id: string, name: string, content: Content) {
    const key = kind + ':' + id;
    let entry = this.open.get(key);
    if (!entry) {
      if (this.open.size >= 128) throw new Error('Too many concurrent Codex items.');
      entry = { item: { kind, id, name, position: this.position++ }, content, size: 0 };
      this.open.set(key, entry);
    }
    return entry;
  }

  private account(entry: Entry, size: number) {
    if (this.buffered + size - entry.size > 4 * codexFrameLimit) throw new Error('Codex output buffer is full.');
    this.buffered += size - entry.size;
    entry.size = size;
  }

  message(id: string, value: string, delta: boolean, complete: boolean, phase?: AgentText['phase']) {
    const entry = this.entry('message', id, 'Message', { id, text: '', status: 'streaming' });
    const content = entry.content as AgentText;
    this.account(entry, value.length + (delta ? content.text.length : 0));
    content.text = delta ? content.text + value : value;
    if (phase) content.phase = phase;
    if (complete) this.finish(entry);
    return content.text;
  }

  tool(id: string, name: string, args: unknown, status: AgentTool['status'], result: unknown, metadata?: Record<string, unknown>, shell?: AgentTool['shell']) {
    const entry = this.entry('tool', id, name, { id, name, arguments: '', status });
    const content = entry.content;
    if ('text' in content) throw new Error('Unexpected Codex item type.');
    content.status = status;
    if (args !== undefined) content.arguments = typeof args === 'string' ? args : JSON.stringify(args);
    if (shell) content.shell = shell;
    if (metadata) content.metadata = metadata;
    // A command can emit full deltas followed by an abbreviated aggregate.
    const useDeltas = name === 'shell' && typeof result === 'string' && (content.result?.length ?? 0) > result.length;
    if (result != null && !useDeltas) content.result = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    this.account(entry, content.arguments.length + (content.result?.length ?? 0) + (content.output?.length ?? 0) + (metadata ? JSON.stringify(metadata).length : 0));
    if (status === 'completed' || status === 'interrupted') this.finish(entry);
  }

  delta(id: string, value: string, field: 'result' | 'output' = 'result') {
    const entry = this.open.get('tool:' + id);
    if (!entry || 'text' in entry.content) return;
    this.account(entry, entry.size + value.length);
    entry.content[field] = (entry.content[field] ?? '') + value;
  }

  flush() {
    for (const entry of this.open.values()) this.finish(entry);
  }

  private finish(entry: Entry) {
    const { content, item } = entry;
    if ('text' in content) {
      content.text = this.visible(content.text, true);
      content.status = 'complete';
    } else {
      if (content.status === 'running' || content.status === 'calling') content.status = 'interrupted';
      item.status = content.status === 'interrupted' ? 'interrupted' : 'completed';
    }
    const serialized = JSON.stringify(content);
    let part = 0;
    for (let start = 0; start < serialized.length;) {
      let end = Math.min(start + 12000, serialized.length);
      // PostgreSQL JSON strings must contain whole Unicode scalars.
      if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1]!)) end--;
      this.write({ ...item, ...(!('text' in content) && content.shell && end===serialized.length ? {shell:content.shell} : {}), part: part++, last: end === serialized.length, data: serialized.slice(start, end) });
      start = end;
    }
    this.buffered -= entry.size;
    this.open.delete(item.kind + ':' + item.id);
  }
}
