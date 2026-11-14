import { useEffect, useState,type ReactNode } from 'react';
import type { ChatMessage } from '@space/contracts';
import { Badge, Button, IconButton, Skeleton } from '@space/ui/primitives';
import { AgentMessageBody } from '../agents/AgentMessageBody.js';
import { request } from '../../shared/api/request.js';
import { X } from '@phosphor-icons/react';
import { AssetAttachments } from '../files/AssetAttachments.js';

export function SourceMessage({ renderEncrypted,direct, channel, name, messageId, onClose, onUnavailable, onOpenThread }: { renderEncrypted?:(message:ChatMessage)=>ReactNode; onOpenThread?: () => void; direct?: boolean; channel: string; name: string; messageId: string; onClose: () => void; onUnavailable?: () => void }) {
  const [message, setMessage] = useState<ChatMessage>(), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setMessage(undefined); setError('');
    void request<ChatMessage>(`/channels/${channel}/messages/${encodeURIComponent(messageId)}`, undefined, undefined, 'POST', controller.signal).then(result => { if (!controller.signal.aborted) setMessage(result); })
      .catch(e => { if (!controller.signal.aborted) { setMessage(undefined); setError(e instanceof Error ? e.message.replaceAll('_', ' ') : 'Unable to load original message'); if (e instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(e.message)) onUnavailable?.(); } });
    return () => controller.abort();
  }, [channel, messageId]);
  const title = `Original message in ${direct ? '' : '#'}${name}`;
  const body = <div className="channel-memory">
    {error ? <p role="alert">{error}</p> : message ? <><strong>{message.author.name}</strong>{message.author.kind === 'app' && <Badge>App</Badge>}{message.author.kind === 'workflow' && <Badge>Workflow</Badge>}<small>{new Date(message.created_at).toLocaleString()}</small>
      {message.deleted_at ? <em className="chat-deleted-message">This message was deleted.</em> : <>{message.encrypted && renderEncrypted ? renderEncrypted(message) : <AgentMessageBody message={message} />}
      {!!message.attachments?.length && <AssetAttachments assets={message.attachments} />}</>}
    </> : <div className="source-message-placeholder" role="status">
      <span className="sp-sr-only">Loading original message…</span>
      <Skeleton width="30%" height={14} /><Skeleton width="20%" height={10} />
      <Skeleton width="85%" height={10} /><Skeleton width="62%" height={10} />
    </div>}
  </div>;
  return <section className="channel-search-source" aria-label={title}>
    <header><strong>{title}</strong><IconButton label="Close original message" onClick={onClose}><X size={16}/></IconButton></header>
    {body}
    {message && !message.deleted_at && onOpenThread && <Button size="sm" onClick={onOpenThread}>Open thread</Button>}
  </section>;
}
