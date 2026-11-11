import type { ChannelSummary } from '@space/contracts';

export function visibleChannels(items: ChannelSummary[]) {
  return items
    .filter(channel => channel.joined && !channel.archived_at && channel.kind !== 'direct')
    .sort((a, b) => a.name.localeCompare(b.name));
}
