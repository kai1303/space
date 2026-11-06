import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { useEffect, useRef, useState } from 'react';
import { Select, Button, Dialog } from '@space/ui/primitives';
import type { NavigatorCandidate, NavigatorRule, NavigationDecision } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import './navigator.css';
type Settings={execution_mode?:'suggest'|'observe';mode:'off'|'rules'|'semantic';rules:NavigatorRule[];daily_token_limit:number;cooldown_seconds:number};
type Configuration={settings:Settings;candidates:NavigatorCandidate[];can_manage:boolean};
type Suggestion={id:string;thread_id:string;decision:NavigationDecision;candidates:NavigatorCandidate[]};
const errorText=(e:unknown)=>e instanceof Error?e.message.replaceAll('_',' '):'Unable to update Navigator';
export function agentMention(candidate:NavigatorCandidate,catalog:NavigatorCandidate[]) {
 const slug=candidate.name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
 const installations=new Set(catalog.filter(c=>c.name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')===slug).map(c=>c.installation_id));
 return slug&&installations.size===1?slug:`agent-${candidate.installation_id}`;
}
type Observation={id:string;thread_id:string;decision:{action:string;reason:string;targetSessionId?:string;delivery_error?:string};created_at:string};
const observationActions:Record<string,string>={suggest:'Suggestion',continue:'Follow-up',stop:'Stop',ignore:'No action',clarify:'Clarification',escalate:'Deeper review'};
function NavigatorObservations({channel}:{channel:string}) {
 const [items,setItems]=useState<Observation[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let active=true;
  setLoading(true);setError('');
  void request<Observation[]>(`/channels/${channel}/navigator/observations`).then(value=>{if(active)setItems(value);}).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[channel,refresh]);
 return <section aria-label="Navigator observations" className="navigator-settings">
  <h3>Recent observations</h3>
  <p>Review the latest 20 recorded decisions.</p>
  <Button size="sm" variant="ghost" disabled={loading} onClick={()=>setRefresh(value=>value+1)}>Refresh observations</Button>
  {error&&<p role="alert">Unable to load observations: {error}</p>}
  {loading&&<p role="status">Loading observations…</p>}
  {!loading&&!error&&!items.length&&<p>No observations yet.</p>}
  {items.map(item=><article className="navigator-suggestion" key={item.id}>
   <strong>{observationActions[item.decision.action]??item.decision.action.replaceAll('_',' ')}</strong>
   <p>{item.decision.reason}</p>
   <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
   {item.decision.delivery_error&&<p>Delivery error: {item.decision.delivery_error.replaceAll('_',' ')}</p>}
  </article>)}
 </section>;
}
export function NavigatorSettings({channel,onCandidates}:{channel:string;onCandidates:(candidates:NavigatorCandidate[])=>void}) {
 const [open,setOpen]=useState(false),[config,setConfig]=useState<Configuration&{channel:string}>(),[settings,setSettings]=useState<Settings>(),[ruleText,setRuleText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const saveScope=useRef<object|undefined>(undefined);
 const canManage=config?.channel===channel&&config.can_manage;
 useEffect(()=>{
  saveScope.current={};setBusy(false);
  return()=>{saveScope.current=undefined;};
 },[channel,open]);
 useEffect(()=>{let active=true;setConfig(undefined);setSettings(undefined);setError('');onCandidates([]);void request<Configuration>(`/channels/${channel}/navigator`).then(value=>{if(active){setConfig({...value,channel});setSettings({...value.settings,execution_mode:value.settings.execution_mode??'suggest'});setRuleText(value.settings.rules.map(r=>`${r.skill}: ${r.keywords.join(', ')}`).join('\n'));onCandidates(value.candidates);}}).catch(e=>{if(active)setError(errorText(e));});return()=>{active=false;};},[channel,onCandidates]);
 async function save(){
  if(!settings||!canManage||busy)return;
  const scope=saveScope.current;
  setBusy(true);setError('');
  try{
   const rules=ruleText.split('\n').filter(line=>line.trim()).map(line=>{const colon=line.indexOf(':');if(colon<1)throw new Error('Use skill: keyword, keyword for each rule');return {skill:line.slice(0,colon).trim(),keywords:line.slice(colon+1).split(',').map(k=>k.trim()).filter(Boolean)};});
   const saved=await request<Settings>(`/channels/${channel}/navigator`,{...settings,rules},undefined,'PATCH');
   if(saveScope.current===scope){setSettings(saved);setOpen(false);}
  }catch(e){if(saveScope.current===scope)setError(errorText(e));}
  finally{if(saveScope.current===scope)setBusy(false);}
 }
 return <>
  <button aria-label="Navigator settings" onClick={()=>setOpen(true)}>Navigator</button>
  <Dialog open={open} onClose={()=>setOpen(false)} title="Navigator">
   <div className="navigator-settings">
    {error&&<p role="alert">{error}</p>}
    {settings?<>
     <p>Mentions go directly to agents. Navigator can suggest help for other conversations.</p>
     <label>Navigation mode<Select aria-label="Navigation mode" disabled={!canManage} value={settings.mode} onChange={e=>setSettings({...settings,mode:e.target.value as Settings['mode']})}><option value="off">Off · direct mentions only</option><option value="rules">Rules only · no model calls</option><option value="semantic">Rules + optional model providers</option></Select></label>
     {settings.mode==='semantic'&&<p>Conversation text may be sent to the model providers configured by your operator. Without a configured provider, rules continue to work.</p>}
     <label>Action mode<Select aria-label="Action mode" disabled={!canManage} value={settings.execution_mode??'suggest'} onChange={e=>setSettings({...settings,execution_mode:e.target.value as Settings['execution_mode']})}><option value="suggest">Suggest and route follow-ups</option><option value="observe">Observe</option></Select></label>
     <p>Observe records proposed suggestions, follow-ups, and stops without doing them. Explicit mentions still start requests.</p>
     <label>Capability rules<textarea disabled={!canManage} value={ruleText} onChange={e=>setRuleText(e.target.value)} placeholder="writing.draft: announcement, draft, write" /></label>
     <small>One rule per line: skill: keyword, keyword</small>
     <label>Daily token reservation limit<input type="number" min="0" max="1000000" disabled={!canManage} value={settings.daily_token_limit} onChange={e=>setSettings({...settings,daily_token_limit:Number(e.target.value)})} /></label>
     <label>Suggestion cooldown in seconds<input type="number" min="0" max="86400" disabled={!canManage} value={settings.cooldown_seconds} onChange={e=>setSettings({...settings,cooldown_seconds:Number(e.target.value)})} /></label>
     {canManage?<Button loading={busy} onClick={()=>void save()}>Save Navigator settings</Button>:<p>A channel manager can change these settings.</p>}
     {open&&canManage&&<NavigatorObservations key={channel} channel={channel} />}
    </>:!error&&<p role="status">Loading Navigator…</p>}
   </div>
  </Dialog>
 </>;
}
export function NavigatorSuggestions({channel,thread,onThread}:{channel:string;thread?:string;onThread?:(id:string)=>void}) {
 const [items,setItems]=useState<Suggestion[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState<string>();
 useEffect(()=>{let active=true,inFlight=false;setItems([]);setError('');async function load(){if(!active||inFlight)return;inFlight=true;try{const data=await request<Suggestion[]>(`/channels/${channel}/navigator/suggestions${thread?`?thread_id=${encodeURIComponent(thread)}`:''}`);if(active)setItems(data);}catch(e){if(active)setError(errorText(e));}finally{inFlight=false;}}const stop=subscribeUpdates('channel',channel,load,code=>{active=false;setItems([]);setError(errorText(new Error(code)));});return()=>{active=false;stop();};},[channel,thread]);
 async function decide(item:Suggestion,candidate?:NavigatorCandidate){setBusy(item.id);setError('');try{await request(`/navigator/suggestions/${item.id}/${candidate?'accept':'dismiss'}`,candidate?{installation_id:candidate.installation_id,skill:candidate.skill}:{});setItems(old=>old.filter(s=>s.id!==item.id));if(candidate)onThread?.(item.thread_id);}catch(e){setError(errorText(e));}finally{setBusy(undefined);}}
 if(!items.length&&!error)return null;
 return <div className="navigator-suggestions">{error&&<p role="alert">{error}</p>}{items.map(item=><article className="navigator-suggestion" key={item.id}><strong>Navigator <small>Suggestion</small></strong><p>{item.decision.reason}</p>{item.decision.tasks?.map(task=><p key={task.id}>{task.title}{!!task.dependsOn.length&&<small> · after {task.dependsOn.join(', ')}</small>}</p>)}<div className="navigator-suggestion-actions">{!thread&&onThread&&<Button size="sm" variant="ghost" onClick={()=>onThread(item.thread_id)}>View thread</Button>}{item.candidates.map(candidate=><Button size="sm" key={`${candidate.installation_id}:${candidate.skill}`} disabled={!!busy} onClick={()=>void decide(item,candidate)}>Ask {candidate.name} · {candidate.skill}</Button>)}<Button size="sm" variant="ghost" disabled={!!busy} onClick={()=>void decide(item)}>Dismiss suggestion</Button></div></article>)}</div>;
}

export function ThreadAgentSubscription({thread}:{thread:string}) {
 const [subscription,setSubscription]=useState<{name:string;can_close:boolean}|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true,inFlight=false;setSubscription(null);setError('');async function load(){if(!active||inFlight)return;inFlight=true;try{const value=await request<{name:string;can_close:boolean}|null>(`/threads/${thread}/agent-subscription`);if(active)setSubscription(value&&typeof value.name==='string'?value:null);}catch(e){if(active)setError(errorText(e));}finally{inFlight=false;}}const stop=subscribeUpdates('thread',thread,load,code=>{active=false;setSubscription(null);setError(errorText(new Error(code)));});return()=>{active=false;stop();};},[thread]);
 async function close(){try{await request(`/threads/${thread}/agent-subscription/close`,{});setSubscription(null);setError('');}catch(e){setError(errorText(e));}}
 if(!subscription&&!error)return null;
 return <div className="navigator-subscription">{subscription&&<><small>{subscription.name} receives follow-ups in this thread.</small>{subscription.can_close&&<Button size="sm" variant="ghost" onClick={()=>void close()}>End agent follow-ups</Button>}</>}{error&&<p role="alert">{error}</p>}</div>;
}
