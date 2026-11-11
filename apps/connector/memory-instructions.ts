import type { InvocationRequest } from '@space/contracts';

type Titles = { notes: unknown[]; truncated: boolean };
type Context = InvocationRequest['context'] | { knowledge_notes?: Titles } | undefined;

// Memory is built from messages, so agents write none. The only thing an agent may add is settled Knowledge,
// and only when the channel has Knowledge on. The block rides on the agent's own final answer, so it costs no extra model call.
export function memoryInstructions(context: Context): string {
  const knowledge = context?.knowledge_notes;
  if (!knowledge) return '';
  return '\n\nOnly when you have settled knowledge that other threads should find later, add one hidden block after your answer. People never see it:\n'
    + '<space-memory>{"notes":[{"kind":"fact|decision|procedure|answer","title":"…","content":"…","message_ids":["…"]}]}</space-memory>\n'
    + 'At most 3 notes, each at most 2000 characters, citing message IDs from this channel. Reuse a title from knowledge_notes to update that note instead of adding a new one.'
    + (knowledge.truncated ? ' The title list is truncated, so search knowledge first before adding a new title.' : '');
}
