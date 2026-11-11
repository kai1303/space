import type { ChannelMemoryPage, SessionMemory, ThreadCheckpoint, ThreadMemory } from '@space/contracts';
import { request } from '../../shared/api/request.js';

export type CheckpointEdit = { revision: number; summary: string; content: string };
// request() sends GET when there is no body; 'POST' is only passed to reach the signal argument.
export const memoryApi = {
  layers: (channel: string, after?: string, signal?: AbortSignal) =>
    request<ChannelMemoryPage>(`/channels/${channel}/memory/layers${after ? `?after=${encodeURIComponent(after)}&limit=50` : ''}`, undefined, undefined, 'POST', signal),
  thread: (channel: string, thread: string, signal?: AbortSignal) =>
    request<ThreadMemory>(`/channels/${channel}/threads/${thread}/memory`, undefined, undefined, 'POST', signal),
  session: (channel: string, session: string, signal?: AbortSignal) =>
    request<SessionMemory>(`/channels/${channel}/agent-sessions/${session}/memory`, undefined, undefined, 'POST', signal),
  saveThread: (channel: string, thread: string, edit: CheckpointEdit) =>
    request<ThreadCheckpoint>(`/channels/${channel}/threads/${thread}/memory`, edit),
  saveSession: (channel: string, session: string, edit: CheckpointEdit) =>
    request<ThreadCheckpoint>(`/channels/${channel}/agent-sessions/${session}/memory`, edit),
};
