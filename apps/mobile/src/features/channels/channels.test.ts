import type { ChannelSummary } from '@space/contracts';
import { visibleChannels } from './channels';

const channel = (patch: Partial<ChannelSummary>): ChannelSummary => ({
  id: patch.name ?? 'x', workspace_id: 'w', name: 'x', private: false, joined: true, topic: '', description: '',
  archived_at: null, created_by: null, created_at: '2026-11-11T00:00:00Z', ...patch,
});

it('lists joined, active, non-direct channels by name', () => {
  const result = visibleChannels([
    channel({ name: 'zeta' }), channel({ name: 'alpha' }), channel({ name: 'left', joined: false }),
    channel({ name: 'old', archived_at: '2026-01-01T00:00:00Z' }), channel({ name: 'dm', kind: 'direct' }),
  ]);
  expect(result.map(item => item.name)).toEqual(['alpha', 'zeta']);
});
