import type { AgentSessionTurn } from '@space/contracts';

const labels = { working: 'is working…', thinking: 'is thinking…', responding: 'is responding…', using_tools: 'is using tools…' };
export function AgentActivityIndicator({ name, turn }: { name: string; turn?: AgentSessionTurn }) {
  const state = turn?.task.status;
  const activity = turn?.response?.activity ?? (turn?.response?.tools.some(tool => ['calling', 'running'].includes(tool.status)) ? 'using_tools' : turn?.response?.messages.some(message => message.status === 'streaming' && message.text.trim()) ? 'responding' : 'working');
  const label = state === 'queued' ? 'is queued…' : state === 'awaiting_approval' ? 'is waiting for approval…' : state === 'running' ? labels[activity] : undefined;
  return <div className="chat-typing" role="status" aria-live="polite" aria-atomic="true">{label && <><strong>{name}</strong> <span>{label}</span></>}</div>;
}
