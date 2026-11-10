import { useId, useState } from 'react';
import { NotePencil } from '@phosphor-icons/react';
import { Button, IconButton, Tabs } from '@space/ui/primitives';
import { Spacebot } from '@space/ui/navigation';
import type { AgentSessionReference, HubTodo } from '@space/contracts';
import { useAgentSessionList } from '../../agents/useAgentSessionList.js';
import { useCollection } from './useWorkspaceCollection.js';
import './spacebot-preview.css';

type Props = {
  workspace: string;
  onNewMessage: () => void;
  onOpenSession: (session: AgentSessionReference) => void;
  onOpenTodos: () => void;
};

export function SpacebotPreview(props: Props) {
  return <Preview key={props.workspace} {...props}/>;
}

function Preview({ workspace, onOpenSession, onNewMessage, onOpenTodos }: Props) {
  const [tab, setTab] = useState('Overview');
  const panelId = useId();
  return <div className="spacebot-preview">
    <header className="rail-peek-header">
      <h2><Spacebot size={24}/>Spacebot</h2>
    </header>
    <Tabs label="Spacebot" items={['Overview', 'Agenda'].map(label => ({ id: label, label, panelId }))}
      value={tab} onChange={setTab}/>
    <div role="tabpanel" id={panelId} aria-label={tab}>
      {tab === 'Overview'
        ? <Recents workspace={workspace} onOpenSession={onOpenSession} onNewMessage={onNewMessage}/>
        : <Agenda workspace={workspace} onOpenTodos={onOpenTodos}/>}
    </div>
  </div>;
}

function Recents({ workspace, onOpenSession, onNewMessage }: Omit<Props, 'onOpenTodos'>) {
  const sessions = useAgentSessionList(workspace);
  return <>
    <div className="spacebot-preview-subhead">
      <h3>Recent agent sessions</h3>
      <IconButton label="New message" onClick={onNewMessage}><NotePencil size={18}/></IconButton>
    </div>
    {sessions.loading && <p className="rail-peek-empty" role="status">Loading sessions…</p>}
    {sessions.error && <p className="rail-peek-empty" role="alert">{sessions.error} {!sessions.revoked && <Button size="sm" onClick={() => void sessions.refresh()}>Retry</Button>}</p>}
    {!sessions.loading && !sessions.error && !sessions.items.length && <p className="rail-peek-empty">No recent agent sessions.</p>}
    {!!sessions.items.length && <ul className="rail-peek-list" aria-label="Recent agent sessions">
      {sessions.items.map(session => <li key={session.id}>
        <button type="button" className="rail-peek-row" onClick={() => onOpenSession(session)}>
          <span className="spacebot-preview-session"><strong>{session.title}</strong><small>{session.agent_name}</small></span>
          <time dateTime={session.created_at}>{new Date(session.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
        </button>
      </li>)}
    </ul>}
  </>;
}

function Agenda({ workspace, onOpenTodos }: Pick<Props, 'workspace' | 'onOpenTodos'>) {
  const data = useCollection(workspace, 'todos', 'status=open&reminder=upcoming&sort=due&archived=false');
  return <>
    <div className="spacebot-preview-subhead"><h3>Upcoming reminders</h3><Button size="sm" variant="ghost" onClick={onOpenTodos}>Open To-dos</Button></div>
    {data.loading && <p className="rail-peek-empty" role="status">Loading reminders…</p>}
    {data.error && <p className="rail-peek-empty" role="alert">{data.error} {!data.revoked && <button type="button" onClick={() => void data.retry()}>Retry</button>}</p>}
    {!data.loading && !data.error && !data.items.length && <p className="rail-peek-empty">No upcoming reminders.</p>}
    {!!data.items.length && <ul className="rail-peek-list" aria-label="Upcoming reminders">{(data.items as HubTodo[]).map(todo =>
      <li key={todo.id} className="spacebot-preview-reminder"><strong>{todo.title}</strong>
        {todo.remind_at && <time dateTime={todo.remind_at}>{new Date(todo.remind_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>}
      </li>)}</ul>}
  </>;
}
