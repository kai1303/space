import { useCallback, useRef, useState } from 'react';
import { BookOpen } from '@phosphor-icons/react';
import { Button, Select } from '@space/ui/primitives';
import type { ChannelSummary } from '@space/contracts';
import { ChannelMemory } from './ChannelMemory.js';
import './memory.css';

type Props = { channels: ChannelSummary[]; onOpenChannel: (id: string) => void; loadMore?: () => void; loadingMore?: boolean };

// Workspace Memory page: pick one of your channels and see its memory graph and notes.
// Memory is read per channel, so only channels you have joined are listed.
export function WorkspaceMemory({ channels, onOpenChannel, loadMore, loadingMore }: Props) {
  const joined = channels.filter(channel => channel.joined);
  const [selected, setSelected] = useState('');
  const dirty = useRef(false), trackDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  const current = joined.find(channel => channel.id === selected) ?? joined[0];
  function choose(id: string) {
    if (id === current?.id) return;
    if (dirty.current && !window.confirm('Discard your unsaved memory edits?')) return;
    dirty.current = false; setSelected(id);
  }
  if (!current) return <section className="wd-empty workspace-memory-empty"><span className="wd-empty-icon"><BookOpen size={32} /></span>
    <h2>No channel memory to show</h2><p>Join a channel to see what its agents and members remember.</p>
    {loadMore && <Button loading={loadingMore} onClick={loadMore}>Load more channels</Button>}</section>;
  return <section className="workspace-memory" aria-label="Workspace memory">
    <div className="workspace-memory-toolbar">
      <label>Channel<Select searchable aria-label="Channel" value={current.id} onChange={event => choose(event.target.value)}>
        {joined.map(channel => <option key={channel.id} value={channel.id}># {channel.name}{channel.archived_at ? ' · Archived' : ''}</option>)}
      </Select></label>
      {loadMore && <Button size="sm" loading={loadingMore} onClick={loadMore}>Load more channels</Button>}
      <Button size="sm" onClick={() => onOpenChannel(current.id)}>Open channel</Button>
    </div>
    <ChannelMemory channel={current.id} name={current.name} onDirtyChange={trackDirty} />
  </section>;
}
