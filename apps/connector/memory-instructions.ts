import type { InvocationRequest } from '@space/contracts';

type Revisioned = { checkpoint?: { revision: number } | null };
type Context = InvocationRequest['context'] | { working_memory?: Revisioned; agent_session_memory?: Revisioned } | undefined;

// The block rides on the agent's own final answer, so saving memory costs no extra model call.
export function memoryInstructions(context: Context): string {
  if (!context) return '';
  const thread = context.working_memory?.checkpoint?.revision ?? 0;
  const session = context.agent_session_memory ? context.agent_session_memory.checkpoint?.revision ?? 0 : undefined;
  return `\n\nAfter your answer, add one hidden memory block. People never see it:\n<space-memory>{"thread":{"base_revision":N,"summary":"…","content":"…"}${session === undefined ? '' : ',"session":{"base_revision":N,"summary":"…","content":"…"}'}}</space-memory>\n`
    + `Use thread base_revision ${thread}${session === undefined ? '' : ` and session base_revision ${session}`}. `
    + 'Each content replaces the whole checkpoint: keep decisions, open questions and progress, drop finished items, at most 6000 characters. Each summary is one line of at most 280 characters. '
    + 'Leave out a layer that did not change. If memory_conflicts is present, merge it into your update.';
}
