import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { patchLines, usePatchReview, type SubmitReview } from './PatchReview.js';
import type { Task, TaskStatus, AgentSessionOutputs } from '@space/contracts';
import { Badge, Button, IconButton, SidePanel, Tabs, type Tone } from '@space/ui/primitives';
import { CodeBlock } from '@space/ui/rich-text';
import { ArrowClockwise, ArrowSquareOut, Clock, Code, Desktop, DownloadSimple, FileCode, Files, GitBranch, Globe, Lightning, X } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import './agent-task-workspace.css';

export type TaskOutputs = AgentSessionOutputs;
const states: Record<TaskStatus, { label: string; tone: Tone }> = {
  awaiting_approval: { label: 'Awaiting approval', tone: 'warning' },
  queued: { label: 'Queued', tone: 'neutral' }, running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' }, failed: { label: 'Failed', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'neutral' },
};
export function taskEventStatus(type: string): TaskStatus {
  if (type === 'task.proposed') return 'awaiting_approval';
  if (type === 'task.rejected') return 'rejected';
  if (type.endsWith('.failed')) return 'failed';
  if (type.endsWith('.completed')) return 'completed';
  if (type.startsWith('execution.')) return 'running';
  return 'queued';
}
export function AgentTaskCard({ title, status, detail, agent = 'Agent task', onOpen, onThread }: {
  title: string; status: TaskStatus; detail?: string; agent?: string; onOpen: () => void; onThread?: () => void;
}) {
  const state = states[status];
  return <article className={`agent-task-card agent-task-card--${status}`}>
    <div className="agent-task-card-top"><span className="agent-task-avatar"><Lightning size={18} weight="fill" /></span><strong>{agent}</strong><Badge tone={state.tone} dot>{state.label}</Badge></div>
    <h3>{title}</h3>
    {detail && detail !== title && <p>{detail}</p>}
    <div className="agent-task-card-actions"><Button size="sm" onClick={onOpen}><Desktop size={16} /> Open agent session</Button>{onThread && <Button size="sm" variant="ghost" onClick={onThread}>Open thread</Button>}</div>
  </article>;
}

type ViewProps = {
  task: Task; outputs?: TaskOutputs; channelName?: string; example?: boolean;
  onClose: () => void;
  error?: string; refreshing?: boolean; onRefresh?: () => void;
};
function useWorkspaceDismiss(close: RefObject<HTMLButtonElement | null>, onClose: () => void, enabled: boolean) {
  useEffect(() => { if (enabled) close.current?.focus(); }, [enabled, close]);
  useEffect(() => {
    if (!enabled) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || (event.target as Element)?.closest('dialog')) return;
      event.preventDefault(); onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose, enabled, close]);
}
export function AgentWorkspaceView({ task, outputs, channelName, example = false, onClose, error, refreshing, onRefresh }: ViewProps) {
  const [tab, setTab] = useState('preview');
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  useWorkspaceDismiss(close, onClose, !example);
  const files = outputs?.files ?? [], changes = outputs?.changes ?? [];
  const tabs = [
    { id: 'preview', label: 'Preview', icon: <Globe size={16} /> },
    { id: 'files', label: `Files ${files.length}`, icon: <Files size={16} /> },
    { id: 'changes', label: `Changes ${changes.length}`, icon: <Code size={16} /> },
  ];
  return <SidePanel className={`agent-workspace ${example ? 'agent-workspace--example' : ''}`} role="region" aria-label="Agent workspace">
    <header className="agent-workspace-header"><div><span className="agent-workspace-heading"><Desktop size={19} /><h2>Agent workspace</h2></span><span className="agent-workspace-context">{example ? 'Example run · local sample outputs' : channelName ? `#${channelName}` : 'Task details'}</span></div><div className="agent-workspace-header-actions">{onRefresh && <IconButton label="Refresh task" disabled={refreshing} onClick={onRefresh}><ArrowClockwise size={18} /></IconButton>}<button ref={close} type="button" className="agent-workspace-close" aria-label="Close agent workspace" onClick={onClose}><X size={20} /></button></div></header>
    {error && <div className="agent-workspace-error" role="alert">{error}{onRefresh && <Button size="sm" onClick={onRefresh}>Retry</Button>}</div>}
    <ResultActions actions={outputs?.actions}/><Tabs label="Task results" value={tab} onChange={setTab} items={tabs.map(item => ({ ...item, panelId: `${id}-${item.id}` }))} />
    <div className="agent-workspace-content" role="tabpanel" id={`${id}-${tab}`} aria-label={tabs.find(item => item.id === tab)?.label} tabIndex={0}>
      {tab === 'preview' && <TaskPreview key={outputs?.preview?.url ?? 'preview'} preview={outputs?.preview} />}
      {tab === 'files' && <TaskFiles files={files} />}
      {tab === 'changes' && <TaskChanges changes={changes} baseBranch={outputs?.context?.base_branch} headBranch={outputs?.context?.head_branch} />}

    </div>
    <footer className="agent-workspace-footer"><span><span className={task.status === 'running' ? 'is-live' : ''} />{example ? 'Sample data · no agent is executing' : refreshing ? 'Updating task…' : 'Saved task activity'}</span><span>{task.id.slice(0, 8)}</span></footer>
  </SidePanel>;
}
function EmptyOutput({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="agent-workspace-empty"><span>{icon}</span><h3>{title}</h3><p>{children}</p></div>;
}
function previewUrl(value: string | undefined): string | undefined {
  if (!value) return;
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch { /* Invalid output is never embedded. */ }
}
export function TaskPreview({ preview }: { preview?: TaskOutputs['preview'] }) {
  const [mobile, setMobile] = useState(false), [reload, setReload] = useState(0), [failed, setFailed] = useState(false);
  const url = previewUrl(preview?.url);
  if (!preview) return <EmptyOutput icon={<Globe size={28} />} title="No preview attached">A preview will appear here when the agent shares one.</EmptyOutput>;
  if (preview.state === 'stopped') return <EmptyOutput icon={<Desktop size={28} />} title="Preview is offline">The sandbox is stopped. Saved files and changes are still available.</EmptyOutput>;
  if (preview.state === 'starting') return <EmptyOutput icon={<Clock size={28} />} title="Starting preview">The app is getting ready. You can inspect the files while you wait.</EmptyOutput>;
  if ((!url && !preview.document) || failed) return <EmptyOutput icon={<Globe size={28} />} title="Preview unavailable">The preview could not be opened.{failed && <Button size="sm" onClick={() => { setFailed(false); setReload(value => value + 1); }}>Try again</Button>}</EmptyOutput>;
  return <div className="agent-preview"><div className="agent-preview-toolbar"><span><span className="agent-preview-dot" />{preview.label}</span><Tabs label="Preview size" value={mobile?'mobile':'desktop'} onChange={value=>setMobile(value==='mobile')} items={[{id:'desktop',label:'Desktop'},{id:'mobile',label:'Mobile'}]}/><IconButton label="Reload preview" size="sm" onClick={() => setReload(value => value + 1)}><ArrowClockwise size={16} /></IconButton>{url && <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open preview in a new tab"><ArrowSquareOut size={18} /></a>}</div>
    <div className={`agent-preview-viewport ${mobile ? 'is-mobile' : ''}`}><iframe key={reload} title={preview.label} src={url} srcDoc={preview.document} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" onError={() => setFailed(true)} /></div><p className="agent-preview-caption">{preview.document ? 'Interactive sample preview' : 'Live sandbox preview'} · Previewing does not publish the app.</p></div>;
}
function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(URL.revokeObjectURL.bind(URL, url), 1000);
}
export function TaskFiles({ files }: { files: TaskOutputs['files'] }) {
  const [selected, setSelected] = useState(''), [query, setQuery] = useState(''), [error, setError] = useState('');
  const visible = files.filter(file => file.path.toLowerCase().includes(query.toLowerCase()));
  const file = visible.find(file => file.path === selected) ?? visible[0];
  if (!files.length) return <EmptyOutput icon={<Files size={28} />} title="No files attached">Files created by the agent will be available to inspect and download here.</EmptyOutput>;
  const filename = file?.path.split('/').at(-1) ?? 'output.txt';
  return <div className="agent-files"><div className="agent-files-list"><input type="search" aria-label="Search task files" placeholder="Find a file…" value={query} onChange={event => setQuery(event.target.value)} /><nav aria-label="Task files">{visible.map(item => <button type="button" key={item.path} aria-current={file?.path === item.path ? 'true' : undefined} onClick={() => { setSelected(item.path); setError(''); }}><FileCode size={16} /><span>{item.path}</span></button>)}</nav></div>{file ? <div className="agent-file-view"><div className="agent-file-header"><strong>{file.path}</strong><Button size="sm" onClick={() => { try { downloadText(filename, file.content); } catch { setError('Could not download this file. Try again.'); } }} aria-label={`Download ${filename}`}><DownloadSimple size={15} /> Download</Button></div>{error && <p role="alert">{error}</p>}<CodeBlock code={file.content} language={file.language ?? 'text'} /></div> : <EmptyOutput icon={<Files size={28} />} title="No matching files">Try a different filename.</EmptyOutput>}</div>;
}
export function TaskChanges({ changes, baseBranch, headBranch, onReview }: {
  changes: TaskOutputs['changes']; baseBranch?: string; headBranch?: string; onReview?: SubmitReview;
}) {
  const review = usePatchReview(onReview);
  const [selectedPath, setSelectedPath] = useState('');
  const [lineLimits, setLineLimits] = useState<Record<string, number>>({});
  const file = changes.find(item => item.path === selectedPath) ?? changes[0];
  const lines = useMemo(() => file ? patchLines(file.patch) : [], [file?.patch]);
  if (!file && !review.editor && !review.summary) return <EmptyOutput icon={<Code size={28} />} title="No code changes attached">Code changes will appear here when an agent supplies a diff.</EmptyOutput>;
  const limit = file ? lineLimits[file.path] ?? 120 : 0;
  const inline = file && review.anchor?.path === file.path && review.anchor.patch === file.patch && review.anchor.index < limit;
  return <div className="agent-changes">
    <header className="agent-changes-heading">
      <Code size={18} aria-hidden="true"/><strong>{changes.length} {changes.length === 1 ? 'file' : 'files'} changed</strong>
      {(baseBranch || headBranch) && <div className="agent-diff-branches" aria-label="Branch comparison">
        <GitBranch size={15} aria-hidden="true"/>
        {baseBranch && <code title={`Base branch ${baseBranch}`}>{baseBranch}</code>}
        {baseBranch && headBranch && <span aria-hidden="true">←</span>}
        {headBranch && <code title={`Head branch ${headBranch}`}>{headBranch}</code>}
      </div>}
    </header>
    {review.summary}
    {!inline && review.editor}
    {file && <div className="agent-diff-review">
      {changes.length > 1 && <nav className="agent-diff-paths" aria-label="Changed files">
        {changes.map(item => <button type="button" key={item.path} title={item.path}
          aria-current={item.path === file.path ? 'true' : undefined} onClick={() => setSelectedPath(item.path)}>
          <FileCode size={15} aria-hidden="true"/><span>{item.path}</span>
        </button>)}
      </nav>}
      <section className="agent-diff-file" aria-label={`Changes in ${file.path}`}>
        <header><FileCode size={16} aria-hidden="true"/><strong>{file.path}</strong>
          <span className="agent-diff-added">+{lines.filter(item => item.kind === 'added').length}</span>
          <span className="agent-diff-removed">−{lines.filter(item => item.kind === 'removed').length}</span>
        </header>
        <div className="agent-diff-lines" tabIndex={0} aria-label={`Patch for ${file.path}`}>
          {lines.slice(0, limit).map(({line, index, location, kind, oldNumber, newNumber}) => <Fragment key={index}>
            <div className={`agent-diff-line agent-diff-line--${kind}`}>
              <span className="agent-diff-number" aria-hidden="true">{oldNumber}</span><span className="agent-diff-number" aria-hidden="true">{newNumber}</span>
              {onReview && <button className="agent-diff-comment" type="button" disabled={review.disabled}
                aria-label={`Comment on ${file.path}, ${location}`} onClick={() => review.select({path:file.path, patch:file.patch, index, location, line})}>+</button>}
              <code>{line}</code>
            </div>
            {inline && review.anchor?.index === index && review.editor}
          </Fragment>)}
        </div>
        {limit < lines.length && <Button size="sm" variant="ghost" onClick={() => setLineLimits(current => ({...current, [file.path]:limit + 120}))}>Show more lines in {file.path}</Button>}
      </section>
    </div>}
  </div>;
}

export function ResultActions({ actions }: { actions?: TaskOutputs['actions'] }) {
  const links = actions?.flatMap(action => {
    const url = previewUrl(action.url);
    return url ? [{...action, url}] : [];
  });
  if (!links?.length) return null;
  return <nav className="agent-result-actions" aria-label="Result actions">{links.map((action, index) =>
    <a key={index} href={action.url} rel="noopener noreferrer" target="_blank" title={action.url}>
      {action.label}<ArrowSquareOut size={14} aria-hidden="true"/>
    </a>)}</nav>;
}
type ConnectedProps = { taskId: string; ownerId: string; viewerId: string; channelName?: string; revision?: string; onClose: () => void; onAccessLost?: () => void };
export function AgentTaskWorkspace(props: ConnectedProps) { return <ConnectedWorkspace key={props.taskId} {...props} />; }
function ConnectedWorkspace({ taskId, channelName, revision, onClose, onAccessLost }: ConnectedProps) {
  const [data, setData] = useState<{ task: Task }>();
  const loadingClose = useRef<HTMLButtonElement>(null);
  useWorkspaceDismiss(loadingClose, onClose, !data);
  const [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false), [retry, setRetry] = useState(0);
  const lost = useRef(onAccessLost); lost.current = onAccessLost;
  useEffect(() => {
    let active = true, pending = false, denied = false;
    async function load() {
      if (!active || denied || pending) return;
      pending = true; setRefreshing(true);
      try {
        const task = await request<Task>(`/tasks/${encodeURIComponent(taskId)}`);
        if (!active || denied) return;
        if (task.id !== taskId || !(task.status in states)) throw new Error('Could not load this task.');
        setData({ task }); setError('');
      } catch (cause) {
        if (!active || denied) return;
        const code = cause instanceof Error ? cause.message : '';
        if (['unauthorized', 'forbidden', 'not_found'].includes(code)) {
          denied = true; setData(undefined);
          setError('This task is no longer available.'); lost.current?.();
        } else {
          setError('Could not load the latest task. Try again.');
        }
      } finally { pending = false; if (active) setRefreshing(false); }
    }
    const expired = () => { if (!denied) { denied = true; setData(undefined); setError('Your session has expired.'); lost.current?.(); } };
    const stop = subscribeUpdates('task', taskId, load, () => {
      denied = true; setData(undefined); setError('This task is no longer available.'); lost.current?.();
    });
    window.addEventListener('space:session-expired', expired);
    return () => { active = false; stop(); window.removeEventListener('space:session-expired', expired); };
  }, [taskId, retry, revision]);
  if (!data) return <SidePanel className="agent-workspace" role="region" aria-label="Agent workspace"><header className="agent-workspace-header"><h2>Agent workspace</h2><button ref={loadingClose} type="button" className="agent-workspace-close" aria-label="Close agent workspace" onClick={onClose}><X size={20} /></button></header><div className="agent-workspace-loading">{error ? <><p role="alert">{error}</p><Button onClick={() => setRetry(value => value + 1)}>Retry</Button></> : <p role="status">Loading task workspace…</p>}</div></SidePanel>;
  return <AgentWorkspaceView task={data.task} channelName={channelName} onClose={onClose} refreshing={refreshing} error={error} onRefresh={() => setRetry(value => value + 1)} />;
}
