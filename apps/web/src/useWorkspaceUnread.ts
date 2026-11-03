import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import type { WorkspaceUnread } from '@space/contracts';
import { command, request } from './chat-client.js';

export function useWorkspaceUnread(workspace: string) {
  const [snapshot, setSnapshot] = useState<WorkspaceUnread>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, revision = 0, fetching = false, subscribing = false, resubscribe = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(undefined); setError('');
    const client = io({ transports: ['websocket'], withCredentials: true, autoConnect: false });
    async function subscribe() {
      if (!active || !client.connected) return;
      if (subscribing) { resubscribe = true; return; }
      subscribing = true;
      try { await command(client, 'workspace.subscribe', { workspace_id: workspace }); }
      catch {
        if (active) { setSnapshot(undefined); setError('Unread counts unavailable. Reconnecting…'); client.disconnect(); reconnect(); }
      } finally {
        subscribing = false;
        if (resubscribe) { resubscribe = false; void subscribe(); }
      }
    }
    const receive = (next: WorkspaceUnread) => {
      if (!active || next?.workspace_id !== workspace || !Array.isArray(next.channels)) return;
      revision++; setSnapshot(next); setError('');
    };
    const refresh = async () => {
      // Keep live snapshots on one ordered stream; HTTP and sockets can otherwise overtake one another.
      if (client.connected) { void subscribe(); return; }
      if (fetching || document.hidden) return;
      fetching = true;
      const version = revision;
      try {
        const next = await request<WorkspaceUnread>(`/workspaces/${workspace}/unread`);
        if (!client.connected && version === revision) receive(next);
      } catch (reason) {
        if (!active || client.connected || version !== revision) return;
        if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) setSnapshot(undefined);
        setError('Unread counts unavailable. Reconnecting…');
      } finally { fetching = false; }
    };
    client.on('workspace.unread', (next: WorkspaceUnread, ack: () => void) => { if (client.connected) receive(next); ack(); });
    client.on('connect', () => { void subscribe(); });
    function reconnect() {
      if (!active || retry) return;
      retry = setTimeout(() => { retry = undefined; if (active) client.connect(); }, 1000);
    }
    client.on('disconnect', reason => { if (active && reason === 'io server disconnect') reconnect(); });
    client.on('chat.error', (reason: { error: string }) => {
      if (!active) return;
      setError('Unread counts unavailable. Reconnecting…');
      if (['unauthorized', 'not_found', 'forbidden'].includes(reason.error)) setSnapshot(undefined);
    });
    client.on('connect_error', error => {
      if (active && error.message === 'unauthorized') window.dispatchEvent(new Event('space:session-expired'));
    });
    void refresh(); client.connect();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { active = false; clearTimeout(retry); client.disconnect(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [workspace]);
  return { channels: snapshot?.workspace_id === workspace ? snapshot.channels : [], error };
}
