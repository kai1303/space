import { useEffect, useState } from 'react';
import type { ChatMessage } from '@space/contracts';
import { Dialog, RichContent } from '@space/ui';
import { request } from './chat-client.js';
import { AssetAttachments } from './AssetAttachments.js';

export function SourceMessage({ channel, name, messageId, onClose, onUnavailable }: { channel: string; name: string; messageId: string; onClose: () => void; onUnavailable?: () => void }) {
  const [message, setMessage] = useState<ChatMessage>(), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request<ChatMessage>(`/channels/${channel}/messages/${encodeURIComponent(messageId)}`).then(result => { if (active) setMessage(result); })
      .catch(e => { if (active) { setMessage(undefined); setError(e instanceof Error ? e.message.replaceAll('_', ' ') : 'Unable to load original message'); if (e instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(e.message)) onUnavailable?.(); } });
    return () => { active = false; };
  }, [channel, messageId]);
  return <Dialog open title={`Original message in #${name}`} onClose={onClose}><div className="channel-memory">
    {error ? <p role="alert">{error}</p> : message ? <><strong>{message.author.name}</strong><small>{new Date(message.created_at).toLocaleString()}</small>
      {message.document ? <RichContent document={message.document} /> : <p className="chat-message-text">{message.text}</p>}
      {!!message.attachments?.length && <AssetAttachments assets={message.attachments} />}
    </> : <p role="status">Loading original message…</p>}
  </div></Dialog>;
}
