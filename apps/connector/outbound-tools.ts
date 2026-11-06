import { parseInvocation, type OutboundAccess } from '@space/contracts';
import type { AgentRuntime } from './agent-runtime.js';

export const outboundServer = 'space_outbound';
export const outboundTokenEnv = 'SPACE_OUTBOUND_TOKEN';

// Capabilities belong to a turn, while native conversation IDs stay in provider storage.
export async function turnScopedRuntime(create: (onExit: () => void, outbound?: OutboundAccess, signal?: AbortSignal) => Promise<AgentRuntime>, onExit: () => void): Promise<AgentRuntime> {
  let closed = false, busy = false;
  const exited = () => { if (!closed) { closed = true; onExit(); } };
  let runtime: AgentRuntime | undefined = await create(exited);
  return {
    alive: () => !closed && (!runtime || runtime.alive()),
    stop() { closed = true; runtime?.stop(); runtime = undefined; },
    async invoke(raw, emit, signal) {
      const request = parseInvocation(raw);
      if (closed || busy || signal.aborted) throw new Error('Agent unavailable or busy.');
      busy = true;
      try {
        if (request.outbound) { runtime?.stop(); runtime = undefined; }
        if (!runtime) runtime = await create(exited, request.outbound, signal);
        if (closed || signal.aborted) { runtime.stop(); runtime = undefined; throw new Error('Agent unavailable.'); }
        await runtime.invoke(request, emit, signal);
      } finally {
        if (request.outbound) { runtime?.stop(); runtime = undefined; }
        busy = false;
      }
    },
  };
}
