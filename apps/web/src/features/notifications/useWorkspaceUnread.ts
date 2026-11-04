import { useEffect, useState } from 'react';
import type { WorkspaceUnread } from '@space/contracts';
import { socketCommand as command } from '../../shared/realtime/socket-command.js';
import { request } from '../../shared/api/request.js';
import { acquireRealtime } from '../../shared/realtime/socket-session.js';

export function useWorkspaceUnread(workspace: string) {
  const [snapshot, setSnapshot] = useState<WorkspaceUnread>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, denied = false, revision = 0, fetching = false, subscribing = false, resubscribe = false, generation = 0;
    setSnapshot(undefined); setError('');
    const connection = acquireRealtime(), client = connection.socket;
    const revoke = () => { denied = true; revision++; setSnapshot(undefined); setError('Unread counts unavailable.'); };
    async function subscribe() {
      if (!active || denied || !client.connected) return;
      if (subscribing) { resubscribe = true; return; }
      subscribing = true;
      const attempt = generation;
      try { await command(client, 'workspace.subscribe', { workspace_id: workspace }); }
      catch (reason) {
        if (!active || denied || attempt !== generation) return;
        const code = reason instanceof Error ? reason.message : '';
        if (code === 'unauthorized') connection.expire();
        else if (['not_found', 'forbidden', 'invalid_id'].includes(code)) revoke();
        else { setError('Unread counts unavailable. Reconnecting…'); connection.recover(); }
      } finally { subscribing = false; if (resubscribe) { resubscribe = false; void subscribe(); } }
    }
    const receive = (next: WorkspaceUnread) => {
      if (!active || denied || next?.workspace_id !== workspace || !Array.isArray(next.channels)) return;
      revision++; setSnapshot(next); setError('');
    };
    const refresh = async () => {
      if (!active || denied) return;
      if (client.connected) { void subscribe(); return; }
      if (fetching || document.hidden) return;
      fetching = true;
      const version = revision;
      try {
        const next = await request<WorkspaceUnread>(`/workspaces/${workspace}/unread`);
        if (!client.connected && version === revision) receive(next);
      } catch (reason) {
        if (!active || client.connected || version !== revision) return;
        if (reason instanceof Error && ['unauthorized', 'not_found', 'forbidden'].includes(reason.message)) revoke();
        else setError('Unread counts unavailable. Reconnecting…');
      } finally { fetching = false; }
    };
    connection.on('workspace.unread', (next: WorkspaceUnread) => { if (client.connected) receive(next); });
    connection.on('workspace.revoked', (event: { workspace_id: string }) => { if (event.workspace_id === workspace) revoke(); });
    connection.on('session.revoked', revoke);
    connection.on('connect', () => { void subscribe(); });
    connection.on('disconnect', () => { generation++; });
    connection.on('focus', () => { void refresh(); });
    void refresh(); if (client.connected) void subscribe(); else connection.connect();
    return () => {
      active = false;
      if (client.connected) void command(client, 'workspace.unsubscribe', { workspace_id: workspace }).catch(() => {});
      connection.release();
    };
  }, [workspace]);
  return { channels: snapshot?.workspace_id === workspace ? snapshot.channels : [], error };
}
