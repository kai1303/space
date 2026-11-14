import { useEffect, useId, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { AgentMarkdown, AgentResponse } from '@space/ui/agents';
import { motionTransition } from '@space/ui/motion';
import { IconButton, Tabs } from '@space/ui/primitives';
import { Browser, Code, FileText, Files, GitBranch, GitPullRequest, Folder, LinkSimple, X } from '@phosphor-icons/react';
import type { AgentSessionOutputs, AgentSessionView } from '@space/contracts';
import { TaskChanges, TaskFiles, TaskPreview } from './AgentTaskWorkspace.js';
import { SessionSharedResources } from './SessionSharedResources.js';
import type { SubmitReview } from './PatchReview.js';

export function codeArtifacts(outputs: AgentSessionOutputs) {
  return [
    ...(outputs.changes.length ? [{id:'changes', label:'Code', icon:<Code size={16}/>}] : []),
    ...(outputs.preview ? [{id:'preview', label:'View', icon:<Browser size={16}/>}] : []),
    ...(outputs.files.length ? [{id:'files', label:'Files', icon:<Files size={16}/>}] : []),
    ...(outputs.views ?? []).map(view => ({id:'view-'+view.key, label:view.name, icon:view.type === 'html' ? <Browser size={16}/> : <FileText size={16}/>})),
  ];
}

export function CodeChannelContext({context}: {context:AgentSessionOutputs['context']}) {
  if (!context || !(context.repository || context.head_branch || context.base_branch || context.pull_request)) return null;
  const {repository, base_branch, head_branch, pull_request} = context;
  return <nav className="code-channel-context" aria-label="Project context">
    {repository && (repository.url ? <a href={repository.url} target="_blank" rel="noopener noreferrer"><Folder/>{repository.label}</a> : <span><Folder/>{repository.label}</span>)}
    {(head_branch || base_branch) && <span title={head_branch && base_branch ? 'Head branch into base branch' : 'Branch'}><GitBranch/>{[head_branch,base_branch].filter(Boolean).join(' → ')}</span>}
    {pull_request && <a href={pull_request.url} target="_blank" rel="noopener noreferrer"><GitPullRequest/>{pull_request.label}</a>}
  </nav>;
}

export function CodeChannelArtifacts({outputs, items, selected, open, onSelect, onClose, onReview, session, thread, viewer}: {
  session:string; thread:string; viewer:string; outputs:AgentSessionOutputs; items:ReturnType<typeof codeArtifacts>; selected:string; open:boolean;
  onSelect:(id:string)=>void; onClose:()=>void; onReview?:SubmitReview;
}) {
  const panelId=useId(), header=useRef<HTMLDivElement>(null);
  const reduced=useReducedMotion();
  const tabs=[...items, {id:'resources',label:'Files & links',icon:<LinkSimple size={16}/>}];
  const active=tabs.find(item=>item.id===selected) ?? tabs[0]!;
  const view=outputs.views?.find(view=>'view-'+view.key===active?.id);
  useEffect(()=>{
    if (!open) return;
    const target=header.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? header.current?.querySelector<HTMLElement>('button');
    target?.focus({preventScroll:true});
  },[open]);
  if (!open && !outputs.changes.length) return null;
  return <motion.aside hidden={!open} className="code-channel-artifacts" aria-label="Artifacts"
    initial={false} animate={{opacity:open?1:0,x:open?0:8}} transition={motionTransition(reduced)}
    onKeyDown={event=>{if(event.key==='Escape' && !event.defaultPrevented){event.preventDefault();event.stopPropagation();onClose();}}}>
    <div className="code-artifacts-header" ref={header}>
      <Tabs label="Artifact views" value={active.id} onChange={onSelect} items={tabs.map(item=>({...item,panelId:panelId+item.id}))}/>
      <IconButton label="Close artifacts" onClick={onClose}><X size={17}/></IconButton>
    </div>
    {outputs.changes.length>0 && <div className="code-artifact-panel" hidden={active?.id!=='changes'} id={panelId+'changes'} role="tabpanel" aria-label="Code">
      <TaskChanges changes={outputs.changes} baseBranch={outputs.context?.base_branch} headBranch={outputs.context?.head_branch} onReview={onReview}/>
    </div>}
    {open && active.id!=='changes' && <div key={active.id} className="code-artifact-panel" id={panelId+active.id} role="tabpanel" aria-label={active.label} tabIndex={0}>
      {active.id==='preview' && <TaskPreview preview={outputs.preview}/>}
      {active.id==='files' && <TaskFiles files={outputs.files}/>}
      {active.id==='resources' && <SessionSharedResources session={session} thread={thread} viewer={viewer}/>}
      {view && <PublishedCodeView view={view}/>}
    </div>}
  </motion.aside>;
}

const previewPolicy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";
export function PublishedCodeView({view}: {view:AgentSessionView}) {
  if (view.type === 'html') {
    const document = '<meta http-equiv="Content-Security-Policy" content="'+previewPolicy+'">'+view.content;
    return <iframe className="code-artifact-html" title={view.name} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document}/>;
  }
  return <article className="code-artifact-document">{view.type === 'blocks'
    ? <AgentResponse response={{messages:[],tools:[],components:view.blocks}}/>
    : <><h2>{view.name}</h2><AgentMarkdown text={view.content}/></>}</article>;
}
