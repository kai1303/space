import { useEffect, useState } from 'react';
import { Code } from '@phosphor-icons/react';
import { type ChatMessage, type SessionReport } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';

export function useSessionReports(channel: string, viewer: string, messages?: ChatMessage[], thread?: string) {
  const ids = new Set(messages?.filter(message => !message.deleted_at && message.agent_sessions?.length).map(message => message.thread_id));
  if (thread) ids.add(thread);
  const threads = [...ids].sort().join(',');
  const key = `${viewer}:${channel}:${threads}`;
  const [snapshot, setSnapshot] = useState<{key:string; byThread:Map<string,SessionReport[]>}>();
  useEffect(() => {
    if (!threads || !channel) return;
    const controller = new AbortController();
    const requested = threads.split(',');
    const stop = subscribeUpdates('channel', channel, async () => {
      const byThread = new Map<string,SessionReport[]>();
      for (let index = 0; index < requested.length; index += 32) {
        const page = await request<{items:SessionReport[]}>(`/channels/${channel}/session-reports`, {
          threads: requested.slice(index, index + 32),
        }, undefined, 'POST', controller.signal, viewer);
        for (const report of page.items) {
          const group = byThread.get(report.thread_id) ?? [];
          group.push(report);
          byThread.set(report.thread_id, group);
        }
      }
      if (!controller.signal.aborted) setSnapshot({key, byThread});
    }, () => {controller.abort(); setSnapshot(undefined);});
    return () => {controller.abort(); stop();};
  }, [channel, viewer, threads, key]);
  return snapshot?.key === key ? snapshot.byThread : undefined;
}

type Artifact = NonNullable<SessionReport['artifact']>;
const artifactLabels: Record<Artifact,string> = {changes:'View changes',preview:'Open preview',files:'View files',artifacts:'Open artifacts'};

export function SessionReports({message,inThread,reports,onOpen}:{
  message:ChatMessage; inThread:boolean; reports?:SessionReport[];
  onOpen:(thread:string,id:string,artifact?:Artifact)=>void;
}) {
  if (message.deleted_at || message.encrypted) return null;
  const links = new Map((inThread ? [] : message.agent_sessions ?? []).map(item => [item.id,item.title]));
  const detail = new Map<string,SessionReport>();
  for (const report of reports ?? []) {
    if (inThread && report.source_message_id !== message.id) continue;
    if (!inThread && !links.has(report.id) && report.source_message_id !== message.id) continue;
    links.set(report.id,report.title);
    detail.set(report.id,report);
  }
  return <>{[...links].map(([id,title]) => {
    const report = detail.get(id);
    return <div className="code-channel-unfurl" key={id}>
      <button type="button" data-code-channel-id={id} className="sp-thread-link chat-session-link" aria-label={`Agent session: ${title}`} title={title} onClick={()=>onOpen(message.thread_id,id)}>
        <Code size={16} aria-hidden="true"/><span>{title}</span>
      </button>
      {report && (report.result || report.artifact) && <div className="chat-session-result">
        {report.result && <span>{report.result}</span>}
        {report.artifact && <button type="button" data-code-channel-id={id} onClick={()=>onOpen(message.thread_id,id,report.artifact!)}>{artifactLabels[report.artifact]}</button>}
      </div>}
    </div>;
  })}</>;
}
