import { Check, FolderSimple, Plus, Star } from '@phosphor-icons/react';
import { Popover, toast } from '@space/ui/primitives';
import type { ChannelSummary } from '@space/contracts';
import { errorText } from '../../shared/api/error-text.js';
import { usePersonalSections } from './SidebarSectionsProvider.js';
import { useStarredChannels } from './useStarredChannels.js';

export function ConversationSectionMenu({ channel, viewer }: { channel: ChannelSummary; viewer: string }) {
  const personal = usePersonalSections();
  const starred = useStarredChannels(channel.workspace_id, channel.id, viewer);
  const assignment = personal.assignments.find(item => item.channel_id === channel.id);
  const current = personal.sections.find(section => section.id === assignment?.section_id);
  function move(id: string | null) {
    void personal.move(channel.id, id).catch(reason => toast.error(errorText(reason)));
  }
  function toggleStar() {
    void starred.toggle(channel.id, { ...channel, kind: channel.kind ?? 'channel' }).catch(reason => toast.error(errorText(reason)));
  }
  return <Popover label={current ? `Move conversation from ${current.name}` : 'Organize conversation'}
    panelLabel="Conversation sections" role="menu" floating align="start" className="conversation-section-trigger"
    panelClassName="sp-menu-content conversation-section-menu" triggerClassName="sp-button sp-button--ghost sp-icon-button"
    trigger={current ? current.emoji ?? <FolderSimple size={19}/> : <Star size={19} weight={starred.active ? 'fill' : 'regular'}/>}>
    {close => <>
      {current
        ? <button type="button" role="menuitem" onClick={() => { move(null); close(); }}>Remove from {current.name}</button>
        : <button type="button" role="menuitem" disabled={starred.busy} onClick={() => { toggleStar(); close(); }}>
          <Star size={16} weight={starred.active ? 'fill' : 'regular'}/>{starred.active ? 'Unstar conversation' : 'Star conversation'}
        </button>}
      {personal.sections.map(section => <button type="button" role="menuitemradio" aria-checked={section.id === current?.id}
        key={section.id} onClick={() => { if (section.id !== current?.id) move(section.id); close(); }}>
        <span aria-hidden="true">{section.emoji ?? <FolderSimple size={16}/>}</span>{section.name}
        {section.id === current?.id && <Check size={16}/>}
      </button>)}
      <hr role="separator"/>
      <button type="button" role="menuitem" onClick={() => { close(false); personal.createSection(channel.id); }}>
        <Plus size={16}/>Create new section
      </button>
    </>}
  </Popover>;
}
