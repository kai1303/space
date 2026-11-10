import { readAgentResponse } from './AgentMessageBody.js';
import { AgentResponse } from '@space/ui/agents';
import { AgentTaskCard, taskEventStatus } from './AgentTaskWorkspace.js';
import { useState } from 'react';
import type { ChatEvent } from '@space/contracts';
import { AgentApproval } from '@space/ui/agents';
import { Button } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import type { Profile } from '../profile/profile-types.js';

export function TaskActivity({ event, profile, onThread, onOpenWorkspace, newArrival }: { newArrival?: boolean; event: ChatEvent & { type: 'task.event' }; profile: Profile; onThread?: () => void; onOpenWorkspace: () => void }) {
  const [decision, setDecision] = useState<'pending' | 'approved' | 'rejected'>('pending');
  async function decide(action: 'approve' | 'reject') {
    await request(`/tasks/${event.payload.task_id}/${action}`, {});
    setDecision(action === 'approve' ? 'approved' : 'rejected');
  }
  const response = readAgentResponse(event.payload.data.response);
  if (response) return <article className="chat-task"><AgentResponse newArrival={newArrival} response={response} fallback={String(event.payload.data.result ?? event.payload.data.text ?? '')} streaming={!/\.(completed|failed)$/.test(event.payload.type)} />
    {event.payload.type.endsWith('.failed') && <p role="alert">{String(event.payload.data.error ?? event.payload.data.code ?? 'The agent run failed.')}</p>}
    <div className="chat-actions"><Button size="sm" onClick={onOpenWorkspace}>Open agent session</Button>{onThread && <Button size="sm" variant="ghost" onClick={onThread}>Open thread</Button>}</div>
  </article>;
  if(event.payload.data.conversational && event.payload.type!=='task.proposed')return null;
  if (event.payload.type === 'task.proposed' && event.payload.owner_id === profile.id) return <div className="chat-task chat-task--approval"><AgentApproval requestId={event.payload.task_id} title="Run this agent task?" agent="Agent" scope="This conversation" status={decision} approveLabel="Approve task" rejectLabel="Reject" onDecide={value => decide(value === 'approved' ? 'approve' : 'reject')}><p>{String(event.payload.data.goal ?? 'Review the requested task before allowing it to run.')}</p></AgentApproval><div className="chat-actions"><Button size="sm" onClick={onOpenWorkspace}>Open agent session</Button>{onThread && <Button size="sm" variant="ghost" onClick={onThread}>Open thread</Button>}</div></div>;
  return <div className="chat-task"><AgentTaskCard title={String(event.payload.data.goal ?? 'Agent task')} status={decision === 'approved' ? 'queued' : decision === 'rejected' ? 'rejected' : taskEventStatus(event.payload.type)} detail={String(event.payload.data.text ?? event.payload.data.result ?? event.payload.data.error ?? event.payload.data.code ?? (event.payload.type === 'task.proposed' ? 'Waiting for the agent owner’s approval.' : ''))} onOpen={onOpenWorkspace} onThread={onThread} /></div>;
}
