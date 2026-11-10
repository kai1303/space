import { useEffect, useState } from 'react';
import type { ChatMessage } from '@space/contracts';
import { Badge, Dialog } from '@space/ui/primitives';
import { AgentMessageBody } from '../agents/AgentMessageBody.js';
import { request } from '../../shared/api/request.js';
import { AssetAttachments } from '../files/AssetAttachments.js';

export function SourceMessage({ direct, channel, name, messageId, onClose, onUnavailable }: { direct?: boolean; channel: string; name: string; messageId: string; onClose: () => void; onUnavailable?: () => void }) {
  const [message, setMessage] = useState<ChatMessage>(), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request<ChatMessage>(`/channels/${channel}/messages/${encodeURIComponent(messageId)}`).then(result => { if (active) setMessage(result); })
      .catch(e => { if (active) { setMessage(undefined); setError(e instanceof Error ? e.message.replaceAll('_', ' ') : 'Unable to load original message'); if (e instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(e.message)) onUnavailable?.(); } });
    return () => { active = false; };
  }, [channel, messageId]);
  return <Dialog open title={`Original message in ${direct ? '' : '#'}${name}`} onClose={onClose}><div className="channel-memory">
    {error ? <p role="alert">{error}</p> : message ? <><strong>{message.author.name}</strong>{message.author.kind === 'app' && <Badge>App</Badge>}{message.author.kind === 'workflow' && <Badge>Workflow</Badge>}<small>{new Date(message.created_at).toLocaleString()}</small>
      {message.deleted_at ? <em className="chat-deleted-message">This message was deleted.</em> : <><AgentMessageBody message={message} />
      {!!message.attachments?.length && <AssetAttachments assets={message.attachments} />}</>}
    </> : <p role="status">Loading original message…</p>}
  </div></Dialog>;
}
