import type { HubMessage } from '@space/contracts';
import { Avatar, Button } from '@space/ui/primitives';
import { NavigationIcon } from '@space/ui/navigation';
import { RichContent } from '@space/ui/rich-text';
import { WorkspaceFiles } from '../../files/WorkspaceFiles.js';
import { useCollection, MAX_ITEMS, type CollectionView } from './useWorkspaceCollection.js';
import './workspace-collections.css';
import { WorkspaceTodos } from '../../todos/WorkspaceTodos.js';

export type { CollectionView } from './useWorkspaceCollection.js';
type Props = { initialTodoId?: string; view: CollectionView; workspace: string; onOpen: (target: { channel_id: string; message_id?: string; thread_id?: string }) => void };
const titles = { threads: 'Threads', saved: 'Saved', sent: 'Sent', files: 'Files', todos: 'To-dos' };
const descriptions = { threads: 'Conversations you have joined, all in one place.', saved: 'Keep the messages you want to come back to.', sent: 'Your messages across this workspace.', files: 'Find files shared in your conversations.', todos: 'A place to keep track of what comes next.' };
const date = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Remount before private data or a pending mutation can cross workspace/view boundaries.
export function WorkspaceCollections(props: Props) {
  if (props.view === 'todos') return <WorkspaceTodos key={props.workspace} workspace={props.workspace} initialTodoId={props.initialTodoId} onOpen={props.onOpen}/>;
  if (props.view === 'files') return <WorkspaceFiles key={props.workspace} workspace={props.workspace} onOpen={props.onOpen}/>;
  return <Collection key={`${props.workspace}:${props.view}`} {...props}/>;
}

function Collection({ view, workspace, onOpen }: Props) {
  const data = useCollection(workspace, view);
  const openMessage = (message: HubMessage) => onOpen(view === 'threads' ? { channel_id: message.channel_id, thread_id: message.thread_id } : { channel_id: message.channel_id, message_id: message.id });
  const empty = !data.items.length && !data.loading && !data.error;
  return <main id="chat-messages" tabIndex={-1} className={`workspace-collection workspace-collection--${view}`}>
    <section className="collection-main" aria-label={titles[view]}>
      <header className="collection-heading"><h1>{titles[view]}</h1><p>{descriptions[view]}</p></header>
        {data.error && <div className="collection-error"><p role="alert">{data.error}</p>{!data.revoked && <Button size="sm" onClick={() => void data.retry()}>Retry</Button>}</div>}
        {data.writeError && <p className="collection-error" role="alert">{data.writeError} Your change could not be confirmed. Try the action again.</p>}
        <div className="collection-content" aria-busy={data.loading}>
          {empty && <Empty icon={view} title={view === 'saved' ? 'Save something for later' : view === 'threads' ? 'Your threads, together' : view === 'sent' ? 'No sent messages yet' : 'No files shared yet'} text={view === 'saved' ? 'Save a message from its conversation and find it here whenever you need it.' : view === 'threads' ? 'Threads you start or reply to will appear here. Open a thread to read all replies and respond.' : view === 'sent' ? 'Messages you send in this workspace will appear here.' : 'Files shared in conversations you can access will appear here.'} />}
          <ul className="collection-message-list">{(data.items as HubMessage[]).map(message => <li key={message.id} className="collection-message-card"><header><button type="button" className="collection-source" onClick={() => openMessage(message)}>{message.channel_name}</button><time dateTime={message.created_at}>{date(message.created_at)}</time></header><div className="collection-message"><Avatar name={message.author_name} initials={message.author_name.slice(0, 2).toUpperCase()} size="sm" /><div><strong>{message.author_name}</strong>{message.document ? <RichContent document={message.document} /> : <p className="collection-message-text">{message.text || 'Shared a file'}</p>}</div></div><footer><button type="button" aria-label={`${view === 'threads' ? 'Open thread' : 'View message'} in ${message.channel_name}`} onClick={() => openMessage(message)}>{view === 'threads' ? <><NavigationIcon name="threads" size={16}/>{message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'} · Open thread</> : 'View message'}</button>{view === 'saved' && <button type="button" disabled={data.busy} aria-label={`Remove saved message from ${message.author_name}`} onClick={() => void data.change(`/saved/${encodeURIComponent(message.id)}`, { channel_id: message.channel_id, active: false })}>Remove from saved</button>}</footer></li>)}</ul>
        </div>
        {data.loading && <p className="collection-loading" role="status">Loading {titles[view].toLowerCase()}…</p>}
        {!data.loading && !data.error && data.cursor && <div className="collection-more">{data.items.length < MAX_ITEMS ? <Button variant="secondary" disabled={data.busy} onClick={() => void data.more()}>Load more</Button> : <p>Showing the first {MAX_ITEMS} items. Open a conversation to find older items.</p>}</div>}
    </section>

  </main>;
}

function Empty({ icon, title, text }: { icon: CollectionView; title: string; text: string }) {
  const name = icon === 'saved' ? 'saved' : icon === 'threads' ? 'threads' : icon === 'sent' ? 'drafts' : icon === 'todos' ? 'todos' : 'files';
  return <div className="collection-empty"><span><NavigationIcon name={name} size={38}/></span><h2>{title}</h2><p>{text}</p></div>;
}
