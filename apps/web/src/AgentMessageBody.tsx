import { parseAgentResponse, type ChatMessage, type MentionReference } from '@space/contracts';
import { AgentMarkdown, AgentResponse, RichContent, replaceEmojiShortcodes } from '@space/ui';

export function readAgentResponse(value: unknown) {
  try { return value === undefined || value === null ? undefined : parseAgentResponse(value); }
  catch { return undefined; }
}

export function AgentMessageBody({ message, onMentionClick, viewerId, streaming }: { message: ChatMessage; onMentionClick?: (mention: MentionReference) => void; viewerId?: string; streaming?: boolean }) {
  const response = message.author.kind === 'agent' ? readAgentResponse(message.agent_response) : undefined;
  if (response) return <AgentResponse response={response} fallback={message.text} streaming={streaming} />;
  if (message.document) return <RichContent document={message.document} onMentionClick={onMentionClick} viewerId={viewerId} />;
  return message.author.kind === 'agent' ? <AgentMarkdown text={message.text} /> : <span className="chat-message-text">{replaceEmojiShortcodes(message.text)}</span>;
}
