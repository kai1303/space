import {useCallback,useEffect,useRef,useState,type RefObject} from 'react';
import type {AgentSessionDetail,AgentSessionTurn} from '@space/contracts';
import {request} from '../../shared/api/request.js';
import {HISTORY_LIMIT,type HistoryDirection} from '../chat/history-window.js';

// A turn renders a request and a reply, sharing the DM timeline's message budget.
export const SESSION_HISTORY_LIMIT=HISTORY_LIMIT/2;
type SessionHistory=AgentSessionDetail&{has_newer:boolean};
function mergeTurns(first:AgentSessionTurn[],second:AgentSessionTurn[]){
 const turns=new Map(first.map(turn=>[turn.task.id,turn]));
 for(const turn of second){const prior=turns.get(turn.task.id);if(!prior||turn.task.revision>=prior.task.revision)turns.set(turn.task.id,turn);}
 return [...turns.values()];
}
export function mergeSessionHistory(current:SessionHistory,page:AgentSessionDetail,direction:HistoryDirection):SessionHistory{
 if(direction==='latest')return {...page,has_newer:false};
 const turns=direction==='older'?mergeTurns(page.turns,current.turns):mergeTurns(current.turns,page.turns);
 const overflow=turns.length>SESSION_HISTORY_LIMIT;
 const visible=direction==='older'?turns.slice(0,SESSION_HISTORY_LIMIT):turns.slice(-SESSION_HISTORY_LIMIT);
 return {...current,turns:visible,
  next_cursor:direction==='older'?page.next_cursor:overflow?visible[0]!.task.id:current.next_cursor,
  has_newer:direction==='newer'?!!page.has_newer:current.has_newer||overflow};
}
export function receiveSessionHistory(current:SessionHistory,page:AgentSessionDetail,pinned:boolean):SessionHistory{
 if(!current.turns.length)return {...page,has_newer:false};
 const ids=new Set(current.turns.map(turn=>turn.task.id));
 const overlap=page.turns.some(turn=>ids.has(turn.task.id));
 const gap=!!current.turns.length&&!!page.turns.length&&!overlap&&!!page.next_cursor;
 if(pinned&&!current.has_newer&&gap)return {...page,has_newer:false};
 const updates=mergeTurns(current.turns,page.turns.filter(turn=>ids.has(turn.task.id)));
 if(current.has_newer||gap)return {...current,turns:updates,has_newer:true};
 const turns=mergeTurns(current.turns,page.turns);
 if(turns.length>SESSION_HISTORY_LIMIT&&!pinned)return {...current,turns:updates,has_newer:true};
 const visible=turns.slice(-SESSION_HISTORY_LIMIT);
 return {...current,turns:visible,next_cursor:turns.length>SESSION_HISTORY_LIMIT?visible[0]!.task.id:current.next_cursor,has_newer:false};
}
export function useAgentSessionHistory(initial:AgentSessionDetail,pinned:RefObject<boolean>,onError:(reason:unknown)=>void){
 const [data,setData]=useState<SessionHistory>(()=>({...initial,has_newer:false}));
 const [loading,setLoading]=useState<HistoryDirection|null>(null),[latestVersion,setLatestVersion]=useState(1);
 const [latest,setLatest]=useState(initial);
 const current=useRef(data),busy=useRef<HistoryDirection|null>(null),epoch=useRef(0),error=useRef(onError),previous=useRef(initial),refreshEpoch=useRef(0),latestSnapshot=useRef(initial);
 error.current=onError;
 const update=(page:SessionHistory)=>{current.current=page;setData(page);};
 useEffect(()=>()=>{epoch.current++;},[]);
 useEffect(()=>{
  if(previous.current===initial)return;previous.current=initial;refreshEpoch.current++;latestSnapshot.current=initial;
  setLatest(initial);
  update(receiveSessionHistory(current.current,initial,pinned.current&&busy.current===null));
 },[initial,pinned]);
 const load=useCallback(async(direction:HistoryDirection)=>{
  if(busy.current&&direction!=='latest')return;
  const page=current.current;
  const cursor=direction==='older'?page.next_cursor:page.turns.at(-1)?.task.id;
  if(direction!=='latest'&&(!cursor||!(direction==='older'?page.next_cursor:page.has_newer)))return;
  const refreshVersion=refreshEpoch.current;
  const version=++epoch.current;busy.current=direction;setLoading(direction);
  try{
   let result=await request<AgentSessionDetail>(`/agent-sessions/${initial.session.id}${direction==='latest'?'':`?${direction==='older'?'before':'after'}=${cursor}`}`);
   if(version!==epoch.current)return;
   if(result.session.id!==initial.session.id||!Array.isArray(result.turns))throw new Error('Could not load this session');
   if(direction==='latest'&&refreshEpoch.current!==refreshVersion)result=latestSnapshot.current;
   // An event refresh may have delivered newer task revisions while this page was in flight.
   const merged=mergeSessionHistory(current.current,result,direction);
   if(direction==='latest'){
    merged.turns=mergeTurns(result.turns,current.current.turns.filter(turn=>result.turns.some(item=>item.task.id===turn.task.id&&(turn.task.revision>item.task.revision||(refreshEpoch.current!==refreshVersion&&turn.task.revision===item.task.revision)))));
    latestSnapshot.current=result;setLatest(result);setLatestVersion(value=>value+1);
   }
   update(merged);return result;
  }catch(reason){if(version===epoch.current)error.current(reason);}
  finally{if(version===epoch.current){busy.current=null;setLoading(null);}}
 },[initial.session.id]);
 async function around(task:string,focus=false) {
   const version=++epoch.current;
   try {
     const result=await request<AgentSessionDetail>(`/agent-sessions/${initial.session.id}?around=${task}`);
     if(version!==epoch.current)return;
     if(focus) {pinned.current=false;update({...result,has_newer:!!result.has_newer});}
     else update({...current.current,turns:mergeTurns(current.current.turns,result.turns.filter(t=>current.current.turns.some(existing=>existing.task.id===t.task.id)))});
   } finally {if(epoch.current===version){busy.current=null;setLoading(null);}}
 }
 return {data,latest,loading,latestVersion,load,around};
}
