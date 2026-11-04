import {useCallback,useEffect,useRef,useState,type FocusEvent} from 'react';
import type {Socket} from 'socket.io-client';
import {TYPING_TTL_MS,type RichDocument,type TypingEvent} from '@space/contracts';
import {acquireRealtime} from '../../shared/realtime/socket-session.js';
import { socketCommand as command } from '../../shared/realtime/socket-command.js';

export function useTypingPublisher(socket:Socket|undefined,channel:string,thread?:string,enabled=true){
 const active=useRef(false),last=useRef(0),idle=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const stop=useCallback(()=>{
  clearTimeout(idle.current);
  if(!active.current)return;
  active.current=false;
  if(socket?.connected)void command(socket,'typing.change',{channel_id:channel,...(thread?{thread_id:thread}:{}),active:false}).catch(()=>{});
 },[socket,channel,thread]);
 useEffect(()=>{
  const hidden=()=>{if(document.hidden)stop();};
  window.addEventListener('blur',stop);document.addEventListener('visibilitychange',hidden);
  return()=>{stop();window.removeEventListener('blur',stop);document.removeEventListener('visibilitychange',hidden);};
 },[stop]);
 useEffect(()=>{if(!enabled)stop();},[enabled,stop]);
 const change=useCallback((document:RichDocument)=>{
  if(!enabled||!socket?.connected||!document.ops.some(op=>op.insert.trim())){stop();return;}
  const now=Date.now();
  if(!active.current||now-last.current>=2000){
   active.current=true;last.current=now;
   void command(socket,'typing.change',{channel_id:channel,...(thread?{thread_id:thread}:{}),active:true}).catch(()=>{});
  }
  clearTimeout(idle.current);idle.current=setTimeout(stop,3000);
 },[socket,channel,thread,enabled,stop]);
 const blur=useCallback((event:FocusEvent<HTMLElement>)=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))stop();},[stop]);
 return {change,stop,blur};
}
export function TypingIndicator({channel,thread,viewerId,enabled=true}:{channel:string;thread?:string;viewerId:string;enabled?:boolean}){
 const [users,setUsers]=useState<string[]>([]);
 useEffect(()=>{
  setUsers([]);if(!enabled)return;
  const connection=acquireRealtime(),entries=new Map<string,TypingEvent>();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const update=()=>{
   clearTimeout(timer);const now=Date.now();
   for(const [key,event] of entries)if(event.expires_at<=now)entries.delete(key);
   const users=[...new Map([...entries.values()].map(event=>[event.user.id,event.user.name])).values()];
   setUsers(previous=>previous.length===users.length&&previous.every((name,index)=>name===users[index])?previous:users);
   if(entries.size)timer=setTimeout(update,Math.max(1,Math.min(...[...entries.values()].map(event=>event.expires_at))-now));
  };
  const clear=()=>{entries.clear();update();};
  connection.on('chat.typing',(event:TypingEvent)=>{
   if(event?.channel_id!==channel||event.thread_id!==(thread??null)||event.user?.id===viewerId||typeof event.source_id!=='string'||typeof event.user?.id!=='string'||typeof event.user?.name!=='string'||event.user.name.length>200||typeof event.active!=='boolean'||!Number.isFinite(event.expires_at))return;
   const key=event.source_id;
   if(!event.active)entries.delete(key);
   else if(event.expires_at>Date.now()){
    if(!entries.has(key)&&entries.size>=100)entries.delete(entries.keys().next().value!);
    entries.set(key,{...event,expires_at:Math.min(event.expires_at,Date.now()+TYPING_TTL_MS)});
   }
   update();
  });
  connection.on('disconnect',clear);connection.on('session.revoked',clear);
  connection.on('channel.revoked',event=>{if(event.channel_id===channel)clear();});
  return()=>{clearTimeout(timer);connection.release();};
 },[channel,thread,viewerId,enabled]);
 return <div className="chat-typing" role="status" aria-live="polite" aria-atomic="true">{users.length>2?'Several people are typing':users.length>0?<span><strong>{users[0]}</strong>{users.length===2?<> and <strong>{users[1]}</strong> are typing</>:' is typing'}</span>:null}</div>;
}
