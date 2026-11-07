import { useEffect, useState } from 'react';
import type { ChannelPermissionSnapshot } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';

type State = { key: string; snapshot?: ChannelPermissionSnapshot; error: string };
export function useChannelPermissions(channel: string | undefined, workspace: string) {
  const key = `${workspace}:${channel ?? ''}`;
  const [state, setState] = useState<State>({ key, error: '' });
  useEffect(() => {
    if (!channel) return;
    let active = true, generation = 0;
    let controller: AbortController | undefined;
    async function read() {
      if (!active) return;
      const version = ++generation;
      controller?.abort(); controller = new AbortController();
      setState({ key, error: '' });
      try {
        const snapshot = await request<ChannelPermissionSnapshot>(`/channels/${channel}/permissions`, undefined, undefined, 'POST', controller.signal);
        if (!snapshot?.capabilities || typeof snapshot.capabilities.post !== 'boolean' || typeof snapshot.capabilities.reply !== 'boolean') throw new Error('Invalid channel permissions');
        if (active && version === generation) setState({ key, snapshot, error: '' });
      } catch {
        if (active && version === generation) setState({ key, error: 'Unable to check channel permissions. Reconnect or return to this window to try again.' });
      }
    }
    function revoked() { active = false; generation++; controller?.abort(); setState({ key, error: 'Your access to this channel has changed.' }); }
    const stopChannel = subscribeUpdates('channel', channel, read, revoked);
    const stopWorkspace = subscribeUpdates('workspace', workspace, read, revoked);
    return () => { active = false; generation++; controller?.abort(); stopChannel(); stopWorkspace(); };
  }, [key, channel, workspace]);
  return state.key === key ? state : { key, error: '' };
}
