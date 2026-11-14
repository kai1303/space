import {SavedMessages} from './SavedMessages.js';
import { ThreadInbox, type ThreadDetail, type InlineComposer } from './ThreadInbox.js';
import type { HubMessage } from '@space/contracts';
import { Avatar, Button, ListRowSkeleton } from '@space/ui/primitives';
import { NavigationIcon } from '@space/ui/navigation';
import { RichContent } from '@space/ui/rich-text';
import { WorkspaceFiles } from '../../files/WorkspaceFiles.js';
import { useCollection, MAX_ITEMS, type CollectionView } from './useWorkspaceCollection.js';
import './workspace-collections.css';
import { WorkspaceTodos } from '../../todos/WorkspaceTodos.js';

export type { CollectionView } from './useWorkspaceCollection.js';
type Props = { viewer?: string; renderThread?: ThreadDetail; renderComposer?:InlineComposer; initialTodoId?: string; view: CollectionView; workspace: string; onOpen: (target: { channel_id: string; message_id?: string; thread_id?: string }) => void };
const titles = { threads: 'Threads', saved: 'Saved', sent: 'Sent', files: 'Files', todos: 'To-dos' };
const descriptions = { threads: 'Conversations you have joined, all in one place.', saved: 'Keep the messages you want to come back to.', sent: 'Your messages across this workspace.', files: 'Find files shared in your conversations.', todos: 'A place to keep track of what comes next.' };
const date = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Remount before private data or a pending mutation can cross workspace/view boundaries.
export function WorkspaceCollections(props: Props) {
  if (props.view === 'saved') return <SavedMessages key={props.workspace+':'+props.viewer} {...props}/>;
  if (props.view === 'threads') return <ThreadInbox key={props.workspace} {...props}/>;
  if (props.view === 'todos') return <WorkspaceTodos key={props.workspace} workspace={props.workspace} initialTodoId={props.initialTodoId} onOpen={props.onOpen}/>;
  if (props.view === 'files') return <WorkspaceFiles key={props.workspace} workspace={props.workspace} onOpen={props.onOpen}/>;
  return <Collection key={`${props.workspace}:${props.view}`} {...props}/>;
}

function Collection({ view, workspace, onOpen }: Props) {
  const data = useCollection(workspace, view);
  const openMessage = (message: HubMessage) => onOpen({ channel_id: message.channel_id, message_id: message.id });
  const empty = !data.items.length && !data.loading && !data.error;
  return <main id="chat-messages" tabIndex={-1} className={`workspace-collection workspace-collection--${view}`}>
    <section className="collection-main" aria-label={titles[view]}>
      <header className="collection-heading"><h1>{titles[view]}</h1><p>{descriptions[view]}</p></header>
        {data.error && <div className="collection-error"><p role="alert">{data.error}</p>{!data.revoked && <Button size="sm" onClick={() => void data.retry()}>Retry</Button>}</div>}
        {data.writeError && <p className="collection-error" role="alert">{data.writeError} Your change could not be confirmed. Try the action again.</p>}
        <div className="collection-content" aria-busy={data.loading}>
          {empty && <Empty icon={view} title={view === 'sent' ? 'No sent messages yet' : 'No files shared yet'} text={view === 'sent' ? 'Messages you send in this workspace will appear here.' : 'Files shared in conversations you can access will appear here.'} />}
          <ul className="collection-message-list">{(data.items as HubMessage[]).map(message => <li key={message.id} className="collection-message-card"><header><button type="button" className="collection-source" onClick={() => openMessage(message)}>{message.channel_name}</button><time dateTime={message.created_at}>{date(message.created_at)}</time></header><div className="collection-message"><Avatar name={message.author_name} initials={message.author_name.slice(0, 2).toUpperCase()} size="sm" /><div><strong>{message.author_name}</strong>{message.document ? <RichContent document={message.document} /> : <p className="collection-message-text">{message.text || 'Shared a file'}</p>}</div></div><footer><button type="button" aria-label={`View message in ${message.channel_name}`} onClick={() => openMessage(message)}>View message</button></footer></li>)}</ul>
        </div>
        {data.loading && !data.items.length && <ListRowSkeleton label={`Loading ${titles[view].toLowerCase()}…`} />}
        {!data.error && data.cursor && <div className="collection-more">{data.items.length < MAX_ITEMS ? <Button variant="secondary" loading={data.loadingMore} disabled={data.busy} onClick={() => void data.more()}>Load more</Button> : <p>Showing the first {MAX_ITEMS} items. Open a conversation to find older items.</p>}</div>}
    </section>

  </main>;
}

function Empty({ icon, title, text }: { icon: CollectionView; title: string; text: string }) {
  const name = icon === 'saved' ? 'saved' : icon === 'threads' ? 'threads' : icon === 'sent' ? 'drafts' : icon === 'todos' ? 'todos' : 'files';
  return <div className="collection-empty"><span><NavigationIcon name={name} size={38}/></span><h2>{title}</h2><p>{text}</p></div>;
}
