import { useEffect, useId, useState, type ReactNode } from 'react';
import { CaretRight, Check, Copy, Terminal } from '@phosphor-icons/react';
import { motion, useReducedMotion } from 'motion/react';
import { shellCommand, type AgentTool, type ShellExecution } from '@space/contracts';
import { IconButton } from '../primitives/primitives.js';
import { copyCode } from '../rich-text/code-block.js';
import { Reveal } from '../motion/reveal.js';

function elapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return ms < 1000 ? '<1s' : seconds < 60 ? seconds+'s' : Math.floor(seconds/60)+'m '+seconds%60+'s';
}

function CopyText({label,text}:{label:string;text:string}) {
  const [state,setState] = useState<'idle'|'copied'|'error'>('idle');
  useEffect(()=>setState('idle'),[text]);
  return <><IconButton size="sm" label={state==='copied'?'Copied':label} onClick={async event=>{
    try { await copyCode(text,event.currentTarget); setState('copied'); }
    catch { setState('error'); }
  }}>{state==='copied'?<Check size={14}/>:<Copy size={14}/>}</IconButton>
    {state==='error' && <span role="alert">Copy failed</span>}</>;
}

export function ShellExecutionDetails({tool,summary,running}:{tool:AgentTool;summary:ShellExecution;running:boolean}) {
  const command = shellCommand(tool.arguments) || summary.command;
  const code = summary.exit_code;
  const footer = running ? 'Running' : summary.outcome==='declined' ? 'Declined'
    : code!==undefined && code!==0 ? 'Exit code '+code : summary.outcome==='failed' ? 'Failed'
    : summary.outcome==='stopped' || tool.status==='interrupted' ? 'Stopped'
    : code===0 ? 'Success · Exit code 0' : summary.outcome==='success' ? 'Success' : 'Exit status unavailable';
  return <div className="sp-shell-panel">
    {command && <div className="sp-shell-command"><code><span aria-hidden="true">$ </span>{command}</code><CopyText label="Copy command" text={command}/></div>}
    <div className="sp-shell-output">
      {tool.result ? <><pre tabIndex={0} aria-label="Tool result">{tool.result}</pre><CopyText label="Copy output" text={tool.result}/></>
        : <span>{running?'Waiting for output…':'No output'}</span>}
    </div>
    <div className="sp-shell-footer">{footer}</div>
  </div>;
}

export function ShellExecutionRow({summary,running,interrupted,children}:{summary:ShellExecution;running:boolean;interrupted:boolean;children:ReactNode}) {
  const [open,setOpen] = useState(false);
  const [now,setNow] = useState(Date.now);
  const reduced = useReducedMotion();
  const id = useId();
  const start = summary.started_at_ms;
  useEffect(()=>{
    if (!running || start===undefined) return;
    setNow(Date.now());
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return ()=>clearInterval(timer);
  },[running,start]);
  const duration = running && start!==undefined ? Math.max(0,now-start) : summary.duration_ms;
  const stopped = summary.outcome==='stopped' || (interrupted && !summary.outcome && summary.exit_code===undefined);
  const verb = running ? 'Running' : summary.outcome==='declined' ? 'Declined' : stopped ? 'Stopped' : 'Ran';
  const time = duration===undefined ? '' : (running?' for ':stopped?' after ':' in ')+elapsed(duration);
  return <div className="sp-shell-execution">
    <button className="sp-shell-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(!open)}>
      <Terminal size={15} aria-hidden="true"/>
      <motion.span className="sp-shell-label" data-shimmer={running && !reduced || undefined}
        animate={running && !reduced ? {backgroundPosition:['180% 0%','-20% 0%']} : {backgroundPosition:'0% 0%'}}
        transition={running && !reduced ? {duration:1.6,ease:'linear',repeat:Infinity} : {duration:0}}>
        {verb} {summary.command || 'command'}</motion.span>
      {time && <span className="sp-shell-time">{time}</span>}
      <motion.span className="sp-shell-caret" animate={{rotate:open?90:0}} transition={{duration:reduced?0:0.14}}><CaretRight size={12}/></motion.span>
    </button>
    <Reveal open={open} id={id}>{children}</Reveal>
  </div>;
}
