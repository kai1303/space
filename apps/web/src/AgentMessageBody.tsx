import { parseAgentResponse, type ChatMessage } from '@space/contracts';
import { AgentMarkdown, AgentResponse, RichContent } from '@space/ui';

export function readAgentResponse(value: unknown) {
  try { return value === undefined || value === null ? undefined : parseAgentResponse(value); }
  catch { return undefined; }
}

export function AgentMessageBody({ message }: { message: ChatMessage }) {
  const response = message.author.kind === 'agent' ? readAgentResponse(message.agent_response) : undefined;
  if (response) return <AgentResponse response={response} fallback={message.text} />;
  if (message.document) return <RichContent document={message.document} />;
  return message.author.kind === 'agent' ? <AgentMarkdown text={message.text} /> : <span className="chat-message-text">{message.text}</span>;
}
