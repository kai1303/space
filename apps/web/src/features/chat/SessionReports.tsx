import { Fragment, useEffect, useState } from 'react';
import { Robot } from '@phosphor-icons/react';
import { sessionWorkStatusLabels, type ChatMessage, type SessionReport } from '@space/contracts';
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
const artifactLabels: Record<Artifact,string> = {changes:'View changes',preview:'Open preview',files:'View files'};

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
    const statusId = `session-status-${inThread ? "thread" : "channel"}-${message.id}-${id}`;
    return <Fragment key={id}>
      <button type="button" className="sp-thread-link chat-session-link" aria-label={`Agent session: ${title}`} aria-describedby={report ? statusId : undefined} title={title} onClick={()=>onOpen(message.thread_id,id)}>
        <Robot size={14} aria-hidden="true"/>Agent session<span>{title}</span>
        {report && <small id={statusId}>{sessionWorkStatusLabels[report.status]}</small>}
      </button>
      {report && (report.result || report.artifact) && <div className="chat-session-result">
        {report.result && <span>{report.result}</span>}
        {report.artifact && <button type="button" onClick={()=>onOpen(message.thread_id,id,report.artifact!)}>{artifactLabels[report.artifact]}</button>}
      </div>}
    </Fragment>;
  })}</>;
}
