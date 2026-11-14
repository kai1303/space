import { useEffect, useState, type FormEvent } from 'react';
import { sessionPath, type AgentSessionReference, type SessionDiscoveryPage } from '@space/contracts';
import { Badge, Button, Tabs } from '@space/ui/primitives';
import { MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { NewCodeChannel } from './NewCodeChannel.js';
import { request } from '../../shared/api/request.js';
import { errorText } from '../../shared/api/error-text.js';
import { invalidateUpdates, subscribeUpdates } from '../../shared/realtime/live-updates.js';
import './session-discovery.css';

const defaultFilters = {q:'',scope:'all',archived:'all',agent:'',channel:'',creator:''};
const emptyPage:SessionDiscoveryPage = {items:[],next_cursor:null};

export function SessionDiscovery({workspace,viewer,onOpen}: {workspace:string;viewer:string;onOpen?:(item:AgentSessionReference)=>void}) {
  const [filters,setFilters] = useState(defaultFilters);
  const [creating,setCreating] = useState(false);
  const [params,setParams] = useState('');
  const [cursors,setCursors] = useState<string[]>([]);
  const [attempt,setAttempt] = useState(0);
  const cursor = cursors.at(-1);
  const query = new URLSearchParams(params);
  if (cursor) query.set('before',cursor);
  const url = `/workspaces/${workspace}/agent-sessions/discover?${query}`;
  const [result,setResult] = useState({url:'',page:emptyPage,loading:true,error:''});
  const [mutation,setMutation] = useState({busy:'',error:''});
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setResult({url,page:emptyPage,loading:true,error:''});
    const unsub = subscribeUpdates('workspace',workspace,async () => {
      try {
        const page = await request<SessionDiscoveryPage>(url,undefined,undefined,'POST',controller.signal,viewer);
        if (active) setResult({url,page,loading:false,error:''});
      } catch (reason) {
        if (active) setResult({url,page:emptyPage,loading:false,error:errorText(reason)});
      }
    },code => {
      active = false; controller.abort();
      setResult({url,page:emptyPage,loading:false,error:errorText(new Error(code))});
    });
    return () => { active=false; controller.abort(); unsub(); };
  },[url,workspace,viewer,attempt]);
  function apply(event:FormEvent) {
    event.preventDefault(); applyFilters(filters);
  }
  function applyFilters(values:typeof filters) {
    const next = new URLSearchParams();
    for (const [key,value] of Object.entries(values)) if (value.trim() && (!['archived','scope'].includes(key) || value!=='all')) next.set(key,value.trim());
    setCursors([]); setParams(next.toString());
  }
  async function restore(id:string) {
    setMutation({busy:id,error:''});
    try {
      await request(`/agent-sessions/${id}/sidebar`,{archived:false},undefined,'PATCH',undefined,viewer);
      await invalidateUpdates('workspace',workspace);
      setMutation({busy:'',error:''});
    } catch(reason) { setMutation({busy:'',error:errorText(reason)}); }
  }
  const {page,loading,error} = result.url===url ? result : {page:emptyPage,loading:true,error:''};
  return <section className="session-discovery" aria-label="Browse agent sessions">
    <div className="code-channel-browser-bar"><Tabs label="Session scope" value={filters.scope} items={[{id:'all',label:'All sessions'},{id:'workspace',label:'Explore'}]}
      onChange={scope=>{const next={...filters,scope};setFilters(next);applyFilters(next);}}/>
      <Button size="sm" onClick={()=>setCreating(true)}><Plus size={15}/>New agent session</Button></div>
    {creating && <NewCodeChannel key={workspace+viewer} workspace={workspace} viewer={viewer} onClose={()=>setCreating(false)} onCreated={session=>{
      setCreating(false);
      if(onOpen) onOpen(session); else window.location.assign(sessionPath(session.id)!);
    }}/>}
    <form onSubmit={apply}>
      <label className="session-discovery-search"><MagnifyingGlass size={18}/><input type="search" aria-label="Search session titles and conversations" placeholder="Search titles and conversations" maxLength={160} value={filters.q} onChange={e=>setFilters({...filters,q:e.target.value})}/></label>
      <div className="session-discovery-filters">
        <label>Archive<select value={filters.archived} onChange={e=>setFilters({...filters,archived:e.target.value})}>
          <option value="all">All sessions</option><option value="false">Unarchived</option><option value="true">Archived</option>
        </select></label>
        {(['agent','channel','creator'] as const).map(key=><label key={key}>{ {agent:'Agent',creator:'Created by',channel:'Source channel'}[key]}
          <input maxLength={160} value={filters[key]} onChange={e=>setFilters({...filters,[key]:e.target.value})}/></label>)}
      </div>
      <Button size="sm" type="submit">Search sessions</Button>
    </form>
    {mutation.error && <p role="alert">{mutation.error}</p>}
    {loading ? <p role="status">Loading sessions…</p> : error ? <p role="alert">{error} <Button size="sm" onClick={()=>setAttempt(n=>n+1)}>Retry</Button></p> :
      page.items.length===0 ? <p>No sessions match.</p> : <ul className="session-discovery-list">{page.items.map(item=><li key={item.id}>
        {item.access==='reviewer' ? <a href={`/review/${item.id}`}><strong>{item.title}</strong><small>Shared for review</small></a> : <>
          <a href={sessionPath(item.id)} onClick={e=>{if(onOpen && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey){e.preventDefault();onOpen(item);}}}>
            <strong>{item.title}</strong><small>{item.agent_name} · {item.channel_name}{item.creator_name && ' · '+item.creator_name}</small>
          </a>
          {item.sidebar_archived && <Badge tone="neutral">Archived</Badge>}
          {(item.sidebar_archived || item.sidebar_inactive) && <Button size="sm" disabled={!!mutation.busy} onClick={()=>void restore(item.id)}>{item.sidebar_archived ? 'Unarchive session' : 'Restore to sidebar'}</Button>}
        </>}
      </li>)}</ul>}
    {(cursors.length>0 || page.next_cursor) && <nav aria-label="Session result pages">
      {cursors.length>0 && <Button size="sm" onClick={()=>setCursors(values=>values.slice(0,-1))}>Previous</Button>}
      {page.next_cursor && <Button size="sm" onClick={()=>setCursors(values=>[...values,page.next_cursor!])}>Next</Button>}
    </nav>}
  </section>;
}
