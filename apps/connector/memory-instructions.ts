import type { InvocationRequest } from '@space/contracts';

type Revisioned = { memory?: { revision: number } | null };
type Titles = { notes: unknown[]; truncated: boolean };
type Context = InvocationRequest['context'] | { working_memory?: Revisioned; agent_session_memory?: Revisioned; knowledge_notes?: Titles } | undefined;

// The block rides on the agent's own final answer, so saving memory costs no extra model call.
export function memoryInstructions(context: Context): string {
  if (!context) return '';
  const thread = context.working_memory?.memory?.revision ?? 0;
  const session = context.agent_session_memory ? context.agent_session_memory.memory?.revision ?? 0 : undefined;
  const knowledge = context.knowledge_notes;
  return `\n\nAfter your answer, add one hidden memory block. People never see it:\n<space-memory>{"thread":{"base_revision":N,"summary":"…","content":"…"}${session === undefined ? '' : ',"session":{"base_revision":N,"summary":"…","content":"…"}'}}</space-memory>\n`
    + `Use thread base_revision ${thread}${session === undefined ? '' : ` and session base_revision ${session}`}. `
    + 'Each content replaces the whole memory: keep decisions, open questions and progress, drop finished items, at most 6000 characters. Each summary is one line of at most 280 characters. '
    + 'Leave out a layer that did not change. If memory_conflicts is present, merge it into your update.'
    + (knowledge ? ' You may also add "notes":[{"kind":"fact|decision|procedure|answer","title":"…","content":"…","message_ids":["…"]}] for settled knowledge that other threads should find later. '
      + 'At most 3 notes, each at most 2000 characters, citing message IDs from this channel. Reuse a title from knowledge_notes to update that note instead of adding a new one.'
      + (knowledge.truncated ? ' The title list is truncated, so search knowledge first before adding a new title.' : '') : '');
}
