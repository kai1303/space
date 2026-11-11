import { useState } from 'react';
import { Switch } from '@space/ui/primitives';
import type { ChannelMemory } from '@space/contracts';
import { request } from '../../shared/api/request.js';

type Props = { path: string; enabled: boolean; onChange: (state: ChannelMemory) => void };

// Knowledge notes are long-term and have their own switch, separate from channel memory.
export function KnowledgeSwitch({ path, enabled, onChange }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function change(value: boolean) {
    setBusy(true); setError('');
    try { onChange(await request<ChannelMemory>(`${path}/knowledge`, { enabled: value })); }
    catch (e) { setError(e instanceof Error ? e.message.replaceAll('_', ' ') : 'Unable to change knowledge notes'); }
    finally { setBusy(false); }
  }
  return <div className="channel-memory-knowledge">
    <Switch label="Knowledge notes" checked={enabled} disabled={busy} onChange={value => void change(value)} />
    <p>Agents with contribute access can save settled facts as notes. Anyone who can see this channel can find them.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
