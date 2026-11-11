import { useEffect, useState } from 'react';
import type { ChatMessage } from '@space/contracts';
import { Badge, Button, Dialog, IconButton } from '@space/ui/primitives';
import { AgentMessageBody } from '../agents/AgentMessageBody.js';
import { request } from '../../shared/api/request.js';
import { X } from '@phosphor-icons/react';
import { AssetAttachments } from '../files/AssetAttachments.js';

export function SourceMessage({ direct, channel, name, messageId, onClose, onUnavailable, inline, onOpenThread }: { inline?: boolean; onOpenThread?: () => void; direct?: boolean; channel: string; name: string; messageId: string; onClose: () => void; onUnavailable?: () => void }) {
  const [message, setMessage] = useState<ChatMessage>(), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request<ChatMessage>(`/channels/${channel}/messages/${encodeURIComponent(messageId)}`).then(result => { if (active) setMessage(result); })
      .catch(e => { if (active) { setMessage(undefined); setError(e instanceof Error ? e.message.replaceAll('_', ' ') : 'Unable to load original message'); if (e instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(e.message)) onUnavailable?.(); } });
    return () => { active = false; };
  }, [channel, messageId]);
  const title = `Original message in ${direct ? '' : '#'}${name}`;
  const body = <div className="channel-memory">
    {error ? <p role="alert">{error}</p> : message ? <><strong>{message.author.name}</strong>{message.author.kind === 'app' && <Badge>App</Badge>}{message.author.kind === 'workflow' && <Badge>Workflow</Badge>}<small>{new Date(message.created_at).toLocaleString()}</small>
      {message.deleted_at ? <em className="chat-deleted-message">This message was deleted.</em> : <><AgentMessageBody message={message} />
      {!!message.attachments?.length && <AssetAttachments assets={message.attachments} />}</>}
    </> : <p role="status">Loading original message…</p>}
  </div>;
  if (inline) return <section className="channel-search-source" aria-label={title}>
    <header><strong>{title}</strong><IconButton label="Close original message" onClick={onClose}><X size={16}/></IconButton></header>
    {body}
    {message && !message.deleted_at && onOpenThread && <Button size="sm" onClick={onOpenThread}>Open thread</Button>}
  </section>;
  return <Dialog open title={title} onClose={onClose}>{body}</Dialog>;
}
