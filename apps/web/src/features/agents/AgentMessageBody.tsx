import { parseAgentResponse, type ChatMessage, type MentionReference } from '@space/contracts';
import { AgentMarkdown, AgentResponse } from '@space/ui/agents';
import { RichContent, documentText } from '@space/ui/rich-text';

export function readAgentResponse(value: unknown) {
  try { return value === undefined || value === null ? undefined : parseAgentResponse(value); }
  catch { return undefined; }
}

export function AgentMessageBody({ message, onMentionClick, viewerId, streaming, newArrival, showActivity }: { message: ChatMessage; onMentionClick?: (mention: MentionReference) => void; viewerId?: string; streaming?: boolean; newArrival?: boolean; showActivity?: boolean }) {
  const response = message.author.kind === 'agent' ? readAgentResponse(message.agent_response) : undefined;
  if (response) return <AgentResponse response={response} fallback={message.text} streaming={streaming} newArrival={newArrival} showActivity={showActivity} />;
  if (message.attachments?.length && !(message.document ? documentText(message.document) : message.text).trim()) return null;
  if (!message.document && message.author.kind === 'agent') return <AgentMarkdown text={message.text} streaming={streaming} newArrival={newArrival} />;
  return <RichContent {...(message.document ? { document: message.document } : { text: message.text })} onMentionClick={onMentionClick} viewerId={viewerId} />;
}
