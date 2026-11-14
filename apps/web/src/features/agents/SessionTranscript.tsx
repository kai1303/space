import { LoadingStatus } from '@space/ui/primitives';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { shellCommand, shellExecution, type ShellExecution } from '@space/contracts';
import type { AgentResponse as Response, AgentText, AgentTool, TranscriptItem } from '@space/contracts';
import { AgentMarkdown, AgentResponse, FileToolDetails, ToolExecution, ShellExecutionDetails, ShellExecutionRow } from '@space/ui/agents';
import { request } from '../../shared/api/request.js';

type SavedTool = AgentTool & { metadata?: Record<string,unknown>; output?: string };

type Chunk = { part:number; data:string; last:boolean };
type Page = { items:TranscriptItem[]; next:number|null };

function savedShell(tool:SavedTool):ShellExecution {
  const metadata=tool.metadata;
  const outcome=metadata?.status;
  return {...shellExecution({
    command:shellCommand(tool.arguments), duration_ms:metadata?.durationMs, exit_code:metadata?.exitCode,
    outcome:outcome==='completed'?'success':outcome==='interrupted'?'stopped':outcome,
  }),...tool.shell};
}

async function readTranscriptItem(url:string,item:TranscriptItem,viewer:string,signal?:AbortSignal) {
  const pieces:string[] = [];
  while (!signal?.aborted) {
    const {chunks} = await request<{chunks:Chunk[]}>(withQuery(url,'position='+item.position+(pieces.length?'&after='+(pieces.length-1):'')),undefined,undefined,undefined,signal,viewer);
    if (!chunks.length) throw new Error('Incomplete transcript');
    for (const chunk of chunks) {
      if (chunk.part!==pieces.length) throw new Error('Missing transcript data');
      pieces.push(chunk.data);
    }
    if (chunks.at(-1)?.last) {
      const value = JSON.parse(pieces.join(''));
      if (value?.id!==item.id || (item.kind==='message' ? typeof value.text!=='string' : typeof value.arguments!=='string' || (value.result!==undefined && typeof value.result!=='string'))) throw new Error('Invalid transcript');
      return value;
    }
  }
  throw new Error('Read cancelled');
}

// Copy the message text in timeline order, without loading tool arguments or output.
export async function copySessionResponse(url:string,viewer:string,response:Response|undefined,fallback:string) {
  const archived:TranscriptItem[]=[];
  let next:number|null=null;
  do {
    const page:Page=await request(next===null?url:withQuery(url,'after='+next),undefined,undefined,undefined,undefined,viewer);
    archived.push(...page.items.filter(item=>item.kind==='message'));
    next=page.next;
  } while(next!==null);
  const messages=new Map<string,string>();
  for(const item of archived.reverse()) messages.set(item.id,(await readTranscriptItem(url,item,viewer)).text);
  for(const item of response?.messages??[]) if(!messages.has(item.id)) messages.set(item.id,item.text);
  await navigator.clipboard.writeText([...messages.values()].join('\n\n')||fallback);
}

function TranscriptContent({url,item,viewer,onShell}: {url:string;item:TranscriptItem;viewer:string;onShell?:(summary:ShellExecution)=>void}) {
  const [content,setContent] = useState<AgentText | SavedTool>();
  const [error,setError] = useState(false);
  const [attempt,setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const value=await readTranscriptItem(url,item,viewer,controller.signal);
      if (!controller.signal.aborted) {
        setContent(value);
        if (item.kind==='tool' && item.name==='shell') onShell?.(savedShell(value));
      }
    }
    setError(false);
    void load().catch(()=>{if (!controller.signal.aborted) setError(true);});
    return ()=>controller.abort();
  },[url,item.id,item.position,item.kind,item.name,viewer,attempt,onShell]);
  if (error) return <button type="button" onClick={()=>setAttempt(n=>n+1)}>Retry loading {item.kind==='tool'?'tool output':'message'}</button>;
  if (!content) return <LoadingStatus>Loading {item.kind==='tool'?'tool output':'message'}…</LoadingStatus>;
  if ('text' in content) return <AgentMarkdown text={content.text}/>;
  if (item.name==='shell') return <ShellExecutionDetails tool={content} running={false} summary={{...item.shell,...savedShell(content)}}/>;
  return <div className="session-transcript-details">
    {['edit_file','write_file'].includes(content.name) && <FileToolDetails tool={content}/>}
    {content.arguments && <><strong>Input</strong><pre>{content.arguments}</pre></>}
    {content.result !== undefined && <><strong>Result</strong><pre tabIndex={0} aria-label="Tool result">{content.result}</pre></>}
    {typeof content.output==='string' && <><strong>Output</strong><pre tabIndex={0}>{content.output}</pre></>}
    {content.metadata && <details><summary>Execution details</summary><pre>{JSON.stringify(content.metadata,null,2)}</pre></details>}
  </div>;
}

function withQuery(url:string, query:string) {
  return url + (url.includes('?') ? '&' : '?') + query;
}

export function HistoricalTools({url,viewer}:{url:string;viewer:string}) {
  const [open,setOpen] = useState(false);
  return <div className="session-tool-history">
    <button className="session-transcript-link" type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'Hide saved tool history':'Show saved tool history'}</button>
    {open && <SessionTranscript url={url+'?legacy=1'} version={0} streaming={false} viewer={viewer}/>}
  </div>;
}

function SessionShell({url,item,tool,viewer,streaming}: {url:string;item?:TranscriptItem;tool?:AgentTool;viewer:string;streaming:boolean}) {
  const [loaded,setLoaded]=useState<ShellExecution>();
  const remember=useCallback((summary:ShellExecution)=>setLoaded(summary),[]);
  const summary={...(tool?savedShell(tool):{}),...item?.shell,...loaded};
  const running=!item && streaming && (tool?.status==='running' || tool?.status==='calling');
  return <ShellExecutionRow summary={summary} running={running} interrupted={(item?.status ?? tool?.status)==='interrupted'}>
    {item ? <TranscriptContent item={item} viewer={viewer} url={url} onShell={remember}/> :
      tool && <ShellExecutionDetails tool={tool} running={running} summary={summary}/>}
  </ShellExecutionRow>;
}

export function SessionTranscript({url,version,viewer,response,streaming}: {
  url:string;version:number;viewer:string;response?:Response;streaming:boolean;
}) {
  const [page,setPage] = useState<Page>();
  const [depth,setDepth] = useState(1);
  const [error,setError] = useState(false);
  const [attempt,setAttempt] = useState(0);
  useEffect(()=>{
    if (!version && !url.includes('legacy=1')) return;
    const controller=new AbortController();
    async function load() {
      const items:TranscriptItem[]=[];
      let next:number|null=null;
      for (let i=0;i<depth;i++) {
        const result:Page=await request<Page>(next===null?url:withQuery(url,'after='+next),undefined,undefined,undefined,controller.signal,viewer);
        items.push(...result.items);
        next=result.next;
        if(next===null) break;
      }
      if (!controller.signal.aborted) setPage({items:items.reverse(),next});
    }
    setError(false);
    void load().catch(()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>controller.abort();
  },[url,version,depth,attempt,viewer]);
  const included=new Set(page?.items.map(item=>item.kind+':'+item.id));
  const tools = new Map(response?.tools.map(tool=>[tool.id,tool]));
  const rows: ReactNode[] = [];
  for (const item of page?.items ?? []) {
    const key=item.kind+':'+item.id;
    if (item.kind==='tool' && item.name==='shell') {
      rows.push(<SessionShell key={key} url={url} viewer={viewer} item={item} tool={tools.get(item.id)} streaming={false}/>);
    } else if (item.kind==='message') {
      rows.push(<TranscriptContent key={key} url={url} viewer={viewer} item={item}/>);
    } else {
      rows.push(<ToolExecution key={key} completed points={[{id:item.id,icon:'code',text:item.name+(item.status==='interrupted'?' · Interrupted':item.status==='completed'?' · Completed':''),
        steps:[{id:'output',text:<TranscriptContent url={url} item={item} viewer={viewer}/>}]}]}/>);
    }
  }

  if (response) {
    const messages=new Map(response.messages.map(message=>[message.id,message]));
    const components=new Map(response.components.map(component=>[component.id,component]));
    const order=response.items ?? [...response.tools.map(tool=>({type:'tool' as const,id:tool.id})),...response.messages.map(message=>({type:'message' as const,id:message.id}))];
    let group:Response = {messages:[],tools:[],components:[],items:[]};
    function flushGroup() {
      const first=group.items?.[0];
      if (!first) return;
      rows.push(<AgentResponse key={'recent:'+first.type+':'+first.id} response={group} streaming={streaming} showActivity={false}/>);
      group={messages:[],tools:[],components:[],items:[]};
    }
    for (const item of order) {
      const key=item.type+':'+item.id;
      if (included.has(key) || (item.type!=='component' && page?.next!=null && !streaming)) continue;
      const tool=item.type==='tool'?tools.get(item.id):undefined;
      if (tool?.name==='shell') {
        flushGroup();
        rows.push(<SessionShell key={key} url={url} viewer={viewer} tool={tool} streaming={streaming}/>);
      } else {
        const message=item.type==='message'?messages.get(item.id):undefined;
        const component=item.type==='component'?components.get(item.id):undefined;
        if (message) group.messages.push(message);
        if (tool) group.tools.push(tool);
        if (component) { group.components.push(component); components.delete(item.id); }
        group.items!.push(item);
      }
    }
    for (const component of components.values()) {
      group.components.push(component);
      group.items!.push({type:'component',id:component.id});
    }
    flushGroup();
  }
  return <div className="sp-agent-response">
    {error && <button type="button" onClick={()=>setAttempt(n=>n+1)}>Retry loading transcript</button>}
    {page && page.next!==null && <button className="session-transcript-link" type="button" onClick={()=>setDepth(n=>n+1)}>Show earlier items</button>}
    {rows}
  </div>;
}
