import { useState } from 'react';
import type { HubFile, HubTodo } from '@space/contracts';
import { DotsThreeVertical, File, Medal, Star } from '@phosphor-icons/react';
import { ListRowSkeleton, Popover } from '@space/ui/primitives';
import { useCollection } from './useWorkspaceCollection.js';
import './collection-rail-preview.css';

interface Props {
  view: 'files' | 'todos';
  workspace: string;
  onOpen: (target: { channel_id: string; message_id?: string }) => void;
  onOpenDestination: (todoId?: string) => void;
}

export function CollectionRailPreview(props: Props) {
  return <Preview key={`${props.workspace}:${props.view}`} {...props}/>;
}

function Preview({ view, workspace, onOpen, onOpenDestination }: Props) {
  const [starred, setStarred] = useState(false);
  const files = view === 'files';
  const title = files ? 'Files' : 'To-dos';
  const data = useCollection(workspace, view, files ? `sort=recent&starred=${starred}` : 'status=open&sort=due&archived=false', { preview: true });
  const fileItems = files ? (data.items as HubFile[]).filter(file => !starred || file.starred) : [];
  const todos = files ? [] : (data.items as HubTodo[]).filter(todo => !todo.completed && !todo.archived && !todo.deleted);
  const empty = files ? !fileItems.length : !todos.length;
  const disabled = data.busy || data.revoked;
  return <>
    <header className="rail-peek-header collection-peek-header">
      <h2><button type="button" onClick={() => onOpenDestination()}>{title}</button></h2>
      {files && <button type="button" aria-pressed={starred} disabled={disabled} className="collection-peek-filter" onClick={() => setStarred(value => !value)}><Star size={14} aria-hidden="true" weight={starred ? 'fill' : 'regular'}/>Starred</button>}
    </header>
    <div className="collection-peek-results" aria-busy={data.loading}>
      {data.loading && empty && <ListRowSkeleton label={`Loading ${title.toLowerCase()}…`}/>}
      {data.error && <div className="rail-peek-empty" role="alert">{data.error} {!data.revoked && <button type="button" onClick={() => void data.retry()}>Retry</button>}</div>}
      {data.writeError && <p role="alert" className="rail-peek-empty">{data.writeError}</p>}
      {!data.loading && !data.error && empty && <div className="rail-peek-empty collection-peek-empty">{files
        ? (starred ? 'No starred files yet.' : 'No files shared yet.')
        : <><Medal size={36} aria-hidden="true"/><p>You checked everything off your list.</p></>}</div>}
      {!empty && <ul className="rail-peek-list collection-peek-list" aria-label={files ? 'Files results' : 'Open to-dos'}>
        {files ? fileItems.map(file => <FileRow key={file.id} file={file} disabled={disabled}
          onOpen={() => onOpen({ channel_id: file.channel_id, message_id: file.message_id })}
          onStar={() => void data.change(`/files/${encodeURIComponent(file.id)}/star`, { active: !file.starred })}/>)
          : todos.map(todo => <li key={todo.id} className="collection-peek-item">
            <input type="checkbox" checked={false} disabled={disabled} aria-label={`Mark ${todo.title} complete`}
              onChange={() => void data.change(`/todos/${encodeURIComponent(todo.id)}`, { completed: true, expected_updated_at: todo.updated_at })}/>
            <button type="button" className="rail-peek-row collection-peek-row" onClick={() => {
              if (todo.channel_id && todo.message_id) onOpen({ channel_id: todo.channel_id, message_id: todo.message_id });
              else onOpenDestination(todo.id);
            }}>
              <span className="collection-peek-text"><strong>{todo.title}</strong>
                {todo.remind_at && <small>Reminder · {new Date(todo.remind_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>}
              </span>
            </button>
          </li>)}
      </ul>}
    </div>
  </>;
}

function FileRow({ file, disabled, onOpen, onStar }: { file: HubFile; disabled: boolean; onOpen: () => void; onStar: () => void }) {
  return <li className="collection-peek-item collection-peek-file">
    <button type="button" className="rail-peek-row collection-peek-row" aria-label={`View ${file.filename} in ${file.channel_name}`} onClick={onOpen}>
      <span className={`files-thumbnail files-thumbnail--${file.preview_kind}`}>{file.preview_kind === 'image'
        ? <img alt="" loading="lazy" src={`/v1/assets/${encodeURIComponent(file.id)}/thumbnail`}/>
        : <File size={20} aria-hidden="true"/>}</span>
      <span className="collection-peek-text"><strong>{file.filename}</strong>
        <small>{file.channel_name} · {new Date(file.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>
      </span>
    </button>
    <Popover label={`More actions for ${file.filename}`} role="menu" disabled={disabled}
      className="sp-menu collection-peek-menu" panelClassName="sp-menu-content collection-peek-menu-content"
      triggerClassName="sp-button" trigger={<DotsThreeVertical size={17}/>}>
      {close => <>
        <button ref={revealFileActions} type="button" role="menuitem" onClick={() => { close(); onStar(); }}>{file.starred ? 'Unstar file' : 'Star file'}</button>
        <button type="button" role="menuitem" onClick={() => { close(false); onOpen(); }}>View message</button>
      </>}
    </Popover>
  </li>;
}

function revealFileActions(firstAction: HTMLButtonElement | null) {
  firstAction?.closest('[role="menu"]')?.scrollIntoView?.({ block: 'nearest' });
}
