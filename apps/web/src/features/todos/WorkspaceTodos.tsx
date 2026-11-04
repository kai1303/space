import { useEffect, useRef, useState } from 'react';
import type { HubTodo, Page } from '@space/contracts';
import { Select, Button, Dialog, IconButton, Menu, Popover } from '@space/ui/primitives';
import { RichComposer } from '@space/ui/composer';
import { RichContent } from '@space/ui/rich-text';
import { ArrowsDownUp, Bell, Broom, CaretDown, CheckCircle, DotsThree, FunnelSimple, X } from '@phosphor-icons/react';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import './workspace-todos.css';

type Open = (target: { channel_id: string; message_id?: string }) => void;
type Filters = { status: string; reminder: string; sort: string; archived: boolean };
type Cleanup = { action: 'complete' | 'archive' | 'delete' | 'remove_deleted'; scope: string; after?: string };
const PAGE_SIZE = 24, MAX_ITEMS = 240;
const displayDate = (value: string) => new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const denied = (reason: unknown) => reason instanceof Error && ['unauthorized','forbidden','not_found'].includes(reason.message);
const failure = (reason: unknown) => reason instanceof Error ? reason.message === 'todo_conflict' ? 'This to-do changed elsewhere. Close the editor and reopen it to use the latest version. Your draft is still here.' : reason.message.replaceAll('_',' ') : 'Unable to update to-dos';

function useTodos(workspace: string, filters: Filters) {
  const [items,setItems] = useState<HubTodo[]>([]), [cursor,setCursor] = useState<string|null>(null), [selected,setSelected] = useState<HubTodo>();
  const [loading,setLoading] = useState(true), [busy,setBusy] = useState(false), [error,setError] = useState(''), [revoked,setRevoked] = useState(false);
  const state = useRef({active:true,revoked:false,writing:false,revision:0,pages:1,selectedId:undefined as string|undefined,read:undefined as AbortController|undefined,write:undefined as AbortController|undefined});
  const base = `/workspaces/${encodeURIComponent(workspace)}/hub/todos`;
  const query = new URLSearchParams({status:filters.status,reminder:filters.reminder,sort:filters.sort,archived:String(filters.archived),limit:String(PAGE_SIZE)}).toString();
  function clear() { setItems([]);setCursor(null);setSelected(undefined);state.current.selectedId=undefined; }
  async function load(after?: string) {
    const s=state.current;if(!s.active || s.revoked || s.writing)return;
    s.read?.abort();const controller=new AbortController();s.read=controller;const revision=++s.revision;
    setLoading(true);setError('');
    try {
      const incoming:HubTodo[]=[];let next=after, pages=0;
      do {
        const page=await request<Page<HubTodo>>(`${base}?${query}${next?`&after=${encodeURIComponent(next)}`:''}`,undefined,undefined,'POST',controller.signal);
        incoming.push(...page.items);next=page.next_cursor??undefined;pages++;
      } while(next && !after && pages<s.pages);
      const selectionId=s.selectedId;
      let detail=incoming.find(item=>item.id===selectionId);
      if(selectionId && !detail){
        try {detail=await request<HubTodo>(`${base}/${selectionId}`,undefined,undefined,'POST',controller.signal);}
        catch(reason){if(!denied(reason))throw reason;}
      }
      if(!s.active || controller.signal.aborted || revision!==s.revision)return;
      setItems(previous=>after?[...new Map([...previous,...incoming].map(item=>[item.id,item])).values()].slice(0,MAX_ITEMS):incoming);
      setCursor(next??null);s.pages=after?Math.min(10,s.pages+1):pages;
      if(selectionId && s.selectedId===selectionId){setSelected(detail);if(!detail)s.selectedId=undefined;}
    }catch(reason){if(!s.active || controller.signal.aborted || revision!==s.revision)return;if(denied(reason)){s.revoked=true;setRevoked(true);clear();}setError(failure(reason));}
    finally {if(s.active && revision===s.revision)setLoading(false);}
  }
  useEffect(()=>{
    const s=state.current;s.active=true;s.pages=1;setItems([]);setCursor(null);
    const stop=subscribeUpdates('workspace',workspace,()=>load(),()=>{s.revoked=true;s.revision++;s.read?.abort();s.write?.abort();clear();setRevoked(true);setLoading(false);setBusy(false);setError('You no longer have access to these to-dos.');});
    return()=>{s.active=false;s.revision++;s.read?.abort();stop();};
  },[workspace,query]);
  useEffect(()=>()=>state.current.write?.abort(),[]);
  async function change<T>(path:string,body:object):Promise<T|undefined>{
    const s=state.current;if(!s.active || s.revoked || s.writing)return;
    s.writing=true;s.revision++;s.read?.abort();const controller=new AbortController();s.write=controller;setBusy(true);setLoading(false);setError('');
    try {
      const value=await request<T>(`${base}${path}`,body,undefined,'POST',controller.signal);
      if(!s.active || s.revoked || controller.signal.aborted)return;
      s.writing=false;await load();if(!s.active || s.revoked || controller.signal.aborted)return;return value;
    }catch(reason){if(s.active && !controller.signal.aborted){if(denied(reason))clear();setError(failure(reason));}}
    finally{s.writing=false;if(s.active)setBusy(false);}
  }
  function select(item?:HubTodo){if(item && (!state.current.active || state.current.revoked))return;state.current.selectedId=item?.id;setSelected(item);}
  return {items,cursor,selected,select,loading,busy:busy||revoked,error,revoked,load,change};
}

export function WorkspaceTodos({workspace,onOpen,archived=false}:{workspace:string;onOpen:Open;archived?:boolean}) {
  const [status,setStatus]=useState('all'),[reminder,setReminder]=useState('all'),[sort,setSort]=useState('due');
  const data=useTodos(workspace,{status,reminder,sort,archived});
  const [creating,setCreating]=useState(false),[editing,setEditing]=useState(false),[cleanup,setCleanup]=useState<Cleanup>();
  const [notice,setNotice]=useState(''),[undo,setUndo]=useState<HubTodo>(),[nextCleanup,setNextCleanup]=useState<Cleanup>();
  const addButton=useRef<HTMLSpanElement>(null), detailPane=useRef<HTMLElement>(null);
  useEffect(()=>{if(data.selected&&!editing)detailPane.current?.querySelector<HTMLButtonElement>('button')?.focus();},[data.selected?.id,editing]);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const next=data.items.map(item=>Date.parse(item.remind_at??'')).filter(time=>time>now).sort((a,b)=>a-b)[0];if(!next)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(next-now+20,2_147_483_647));return()=>clearTimeout(timer);},[data.items,now]);
  function close(){setCreating(false);setEditing(false);data.select();addButton.current?.querySelector('button')?.focus();}
  function add(){setCreating(true);setEditing(false);data.select();}
  async function update(item:HubTodo,body:object){return data.change<HubTodo>(`/${item.id}`,body);}
  async function remove(item:HubTodo,action:'archive'|'delete'){
    const saved=await data.change<HubTodo>(`/${item.id}`,{[action==='archive'?'archived':'deleted']:true});
    if(saved){data.select();setEditing(false);setUndo(saved);setNotice(action==='archive'?'Moved to Saved.':'To-do cleared.');}
  }
  async function runCleanup(){
    if(!cleanup)return;const result=await data.change<{items:HubTodo[];next_cursor:string|null}>('/cleanup',cleanup);
    if(result){setNotice(`${result.items.length} to-dos ${cleanup.action==='complete'?'completed':cleanup.action==='archive'?'moved to Saved':'cleared'}.`);setNextCleanup(result.next_cursor?{...cleanup,after:result.next_cursor}:undefined);setCleanup(undefined);data.select();}
  }
  const current=data.selected;
  const filtered=status!=='all'||reminder!=='all';
  return <main id={archived?undefined:'chat-messages'} tabIndex={-1} className="workspace-todos" aria-label={archived?'Saved to-dos':'To-dos'}>
    <section className="todos-list-pane" aria-label="To-do list">
      <header className="todos-heading"><h1>{archived?'Saved to-dos':'To-dos'}</h1><div className="todos-heading-actions">
        {!archived && <span ref={addButton}><Button variant="secondary" size="sm" disabled={data.busy||creating} onClick={add}><CheckCircle size={17}/>Add To-do</Button></span>}
        {!archived && <Menu label="Clean up" trigger={<><Broom size={18}/><CaretDown size={12}/></>} floating items={[{label:'Complete to-dos',onSelect:()=>setCleanup({action:'complete',scope:'all'})},{label:'Move to-dos to Saved',onSelect:()=>setCleanup({action:'archive',scope:'completed'})},{label:'Clear to-dos',onSelect:()=>setCleanup({action:'delete',scope:'completed'})},{label:'Remove deleted messages',onSelect:()=>setCleanup({action:'remove_deleted',scope:'all'})}]}/>}
      </div></header>
      <div className="todos-toolbar" role="toolbar" aria-label="Filter and sort">
        <Popover label="Filter" trigger={<><FunnelSimple size={15}/>Filter{filtered?' •':''}<CaretDown size={12}/></>} triggerClassName="todos-control" panelClassName="todos-filter-panel" floating align="start">{()=> <><strong>Filter by</strong><label>Status<Select aria-label="To-do status" value={status} disabled={data.busy} onChange={e=>setStatus(e.target.value)}><option value="all">All to-dos</option><option value="open">In-progress</option><option value="completed">Completed</option></Select></label><label>Reminder<Select aria-label="To-do reminder filter" value={reminder} disabled={data.busy} onChange={e=>setReminder(e.target.value)}><option value="all">All reminders</option><option value="overdue">Overdue to-dos</option><option value="upcoming">Upcoming reminders</option><option value="none">No reminder scheduled</option></Select></label><button className="todos-link" disabled={data.busy} onClick={()=>{setStatus('all');setReminder('all');}}>Clear filters</button></>}</Popover>
        <Menu label="Sort" trigger={<><ArrowsDownUp size={16}/><CaretDown size={12}/></>} floating items={[['due','Due date'],['oldest','Earliest date created'],['newest','Latest date created']].map(([value,label])=>({label:label!,icon:sort===value?<CheckCircle size={15}/>:undefined,onSelect:()=>{if(!data.busy)setSort(value!);}}))}/>
      </div>
      {data.error && <div className="todos-error" role="alert">{data.error}{!data.revoked&&<button onClick={()=>void data.load()} disabled={data.busy}>Retry</button>}</div>}
      {notice && <div className="todos-notice" role="status">{notice}{undo&&<button disabled={data.busy} onClick={async()=>{const saved=await data.change<HubTodo>(`/${undo.id}`,{deleted:false,archived:archived});if(saved){setNotice('To-do restored.');setUndo(undefined);}}}>Undo</button>}{nextCleanup&&<button disabled={data.busy} onClick={()=>setCleanup(nextCleanup)}>Continue cleanup</button>}<button aria-label="Dismiss notification" onClick={()=>{setNotice('');setUndo(undefined);}}><X size={14}/></button></div>}
      <div className="todos-scroll" aria-busy={data.loading}>
        {!data.loading&&!data.error&&!data.items.length&&<div className="todos-empty"><img className="todos-empty-image" src="/illustrations/todos-empty.svg" alt="" width={157} height={140}/><h2>{archived?'No saved to-dos':filtered?'No matching to-dos':'No to-dos yet'}</h2><p>{archived?'To-dos moved to Saved will appear here.':filtered?'Try changing or clearing your filters.':'Add a to-do from any message, or write your own.'}</p>{!archived&&!filtered&&<Button variant="secondary" size="sm" onClick={add} disabled={data.busy}>Add To-do</Button>}</div>}
        <ul className="todos-rows">{data.items.map(item=><li key={item.id} className={`${current?.id===item.id?'is-selected ':''}${item.completed?'is-completed':''}`}>
          <input type="checkbox" aria-label={`Mark ${item.title} ${item.completed?'incomplete':'complete'}`} checked={item.completed} disabled={data.busy} onChange={e=>void update(item,{completed:e.target.checked})}/>
          <div className="todos-row-body"><button className="todos-row-title" disabled={data.busy} onClick={()=>{data.select(item);setCreating(false);setEditing(false);}}>{item.title}</button>{item.remind_at&&<small className={!item.completed&&Date.parse(item.remind_at)<now?'is-overdue':''}><Bell size={12}/>{item.reminder_fired_at&&!item.completed?'Reminder due · ':''}{displayDate(item.remind_at)}</small>}{item.message_id&&<small>From a message</small>}{item.external&&<small>From {item.external.name} · {item.external.external_id}</small>}</div>
          <Menu label={`Actions for ${item.title}`} trigger={<DotsThree size={22}/>} floating items={[{label:item.completed?'Mark in-progress':'Mark complete',onSelect:()=>void update(item,{completed:!item.completed})},{label:'Edit to-do',onSelect:()=>{data.select(item);setCreating(false);setEditing(true);}},{label:archived?'Move to To-dos':'Move to Saved',onSelect:()=>archived?void data.change(`/${item.id}`,{archived:false}):void remove(item,'archive')},{label:'Clear to-do',danger:true,onSelect:()=>void remove(item,'delete')}]}/>
        </li>)}</ul>
        {data.loading&&<p className="todos-loading" role="status">Loading to-dos…</p>}
        {!data.loading&&data.cursor&&<div className="todos-more">{data.items.length<MAX_ITEMS?<Button variant="secondary" disabled={data.busy} onClick={()=>void data.load(data.cursor!)}>Load more</Button>:<p>Showing 240 to-dos. Use filters to narrow your list.</p>}</div>}
      </div>
    </section>
    <aside ref={detailPane} className={`todos-detail-pane ${creating||current?'is-open':''}`} aria-label="To-do details">
      {creating||current?<><header className="todos-heading"><h2>To-do</h2><IconButton label="Close to-do details" disabled={data.busy} onClick={close}><X size={18}/></IconButton></header><div className="todos-detail-body">
        {creating||editing?<TodoEditor key={creating?'new':current!.id} todo={creating?undefined:current} busy={data.busy} save={async(id,body)=>{const saved=await data.change<HubTodo>(`/${id}`,body);if(!saved)throw new Error('Save failed');setCreating(false);setEditing(false);data.select(saved);}}/>:current&&<>
          <div className="todos-detail-status"><label><input type="checkbox" checked={current.completed} disabled={data.busy} onChange={e=>void update(current,{completed:e.target.checked})}/>{current.completed?'Completed':'In-progress'}</label><button className="todos-link" onClick={()=>setEditing(true)} disabled={data.busy}>Edit</button></div>
          <div className="todos-rich-text">{current.document?<RichContent document={current.document}/>:<p>{current.title}</p>}</div>
          <Reminder value={current.remind_at??null} disabled={data.busy} onChange={value=>void update(current,{remind_at:value})}/>
          {current.reminder_fired_at&&!current.completed&&<p className="todos-due" role="status"><Bell size={16}/>Reminder due · {displayDate(current.remind_at!)}</p>}
          {current.channel_id&&current.message_id&&<button className="todos-link todos-source" onClick={()=>onOpen({channel_id:current.channel_id!,message_id:current.message_id!})}>View message</button>}
          {current.external&&<div className="todos-external"><p>Text and completion follow updates from {current.external.name}.</p>{current.external.url&&<a className="todos-link" href={current.external.url} target="_blank" rel="noopener noreferrer">View in {current.external.name}</a>}</div>}
          <p className="todos-created">Created {displayDate(current.created_at)}</p>
          <div className="todos-detail-actions"><button className="todos-link" disabled={data.busy} onClick={()=>archived?void data.change(`/${current.id}`,{archived:false}).then(()=>data.select()):void remove(current,'archive')}>{archived?'Move to To-dos':'Move to Saved'}</button><button className="todos-link" disabled={data.busy} onClick={()=>void remove(current,'delete')}>Clear to-do</button></div>
        </>}
      </div></>:<p className="todos-select-hint">Select a to-do to view details.</p>}
    </aside>
    <Dialog open={!!cleanup} onClose={()=>{if(!data.busy)setCleanup(undefined);}} title={cleanup?.action==='remove_deleted'?'Remove deleted messages':cleanup?.action==='complete'?'Complete to-dos':cleanup?.action==='archive'?'Move to-dos to Saved':'Clear to-dos'}>
      <p>{cleanup?.action==='delete'?'Cleared to-dos will be removed from your list.':'Choose which to-dos to clean up.'} Up to 240 to-dos are processed at a time.</p>
      {cleanup?.action!=='remove_deleted'&&<label className="todos-cleanup-scope">To-dos<Select aria-label="To-dos" value={cleanup?.scope??'all'} disabled={data.busy} onChange={e=>setCleanup(old=>old?{...old,scope:e.target.value,after:undefined}:old)}><option value="all">All</option><option value="completed">Only completed</option><option value="overdue">Only overdue</option><option value="overdue30">Only overdue by 30+ days</option></Select></label>}
      <div className="todos-dialog-actions"><Button variant="secondary" disabled={data.busy} onClick={()=>setCleanup(undefined)}>Cancel</Button><Button disabled={data.busy} onClick={()=>void runCleanup()}>Confirm</Button></div>
    </Dialog>
  </main>;
}

function TodoEditor({todo,busy,save}:{todo?:HubTodo;busy:boolean;save:(id:string,body:object)=>Promise<void>}) {
  const [remindAt,setRemindAt]=useState(todo?.remind_at??null);
  const attempt=useRef(todo?.id??crypto.randomUUID());
  // Keep the revision captured when editing started; incoming live updates must not discard a draft.
  const revision=useRef(todo?.updated_at);
  return <div className="todos-editor"><RichComposer autoFocus channel="to-do" placeholder="What’s on your to-do list?" defaultValue={todo?.document??(todo?{ops:[{insert:todo.title+'\n'}]}:undefined)} attachmentsEnabled={false} showUnavailableActions={false} maxLength={500} submitLabel={todo?'Save changes':'Add to-do'} sendDisabledReason={busy?'Saving…':undefined} onSend={async(title,document)=>save(attempt.current,{title,document,remind_at:remindAt,...(todo?{expected_updated_at:revision.current}:{completed:false,create_only:true})})}/><Reminder value={remindAt} disabled={busy} onChange={setRemindAt}/></div>;
}

export function reminderPreset(kind:string,now=new Date()):string {
  const date=new Date(now);
  if(['30','60','180'].includes(kind))date.setMinutes(date.getMinutes()+Number(kind));
  else {date.setDate(date.getDate()+(kind==='tomorrow'?1:((8-date.getDay())%7||7)));date.setHours(9,0,0,0);}
  return date.toISOString();
}
function Reminder({value,disabled,onChange}:{value:string|null;disabled:boolean;onChange:(value:string|null)=>void}) {
  const [custom,setCustom]=useState(false),[date,setDate]=useState('');
  return <><Menu label={value?`Reminder: ${displayDate(value)}`:'Add reminder'} className="todos-reminder" trigger={<><Bell size={15}/>{value?displayDate(value):'Add reminder'}<CaretDown size={12}/></>} floating align="start" items={[...([['30','In 30 mins'],['60','In 1 hour'],['180','In 3 hours'],['tomorrow','Tomorrow at 9:00 AM'],['monday','Monday at 9:00 AM']] as const).map(([kind,label])=>({label,onSelect:()=>{if(!disabled)onChange(reminderPreset(kind));}})),{label:'Custom…',onSelect:()=>{if(!disabled){const d=new Date(value??Date.now()+1800000);setDate(new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16));setCustom(true);}}},...(value?[{label:'Remove reminder',onSelect:()=>{if(!disabled)onChange(null);}}]:[])]}/>
    <Dialog open={custom} onClose={()=>setCustom(false)} title="Reminder"><form onSubmit={e=>{e.preventDefault();const when=String(new FormData(e.currentTarget).get('when')??'');if(when&&Number.isFinite(Date.parse(when))){onChange(new Date(when).toISOString());setCustom(false);}}}><label className="todos-custom-date">When<input aria-label="Reminder date and time" name="when" type="datetime-local" required value={date} onChange={e=>setDate(e.target.value)}/></label><div className="todos-dialog-actions"><Button type="button" variant="secondary" onClick={()=>setCustom(false)}>Cancel</Button><Button type="submit" disabled={disabled||!date}>Save</Button></div></form></Dialog>
  </>;
}
