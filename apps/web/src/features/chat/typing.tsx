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
type TypingScope = { workspace?: string; channel?: string; thread?: string; viewerId: string; enabled?: boolean };
const emptyTyping: ReadonlyMap<string, string> = new Map();

function useTypingActivity({ workspace, channel, thread, viewerId, enabled = true }: TypingScope) {
 const scope = JSON.stringify([workspace, channel, thread, viewerId, enabled]);
 const [state, setState] = useState({scope, values: emptyTyping});
 useEffect(() => {
  if (!enabled) return;
  const connection = acquireRealtime();
  const entries = new Map<string, TypingEvent>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
   clearTimeout(timer);
   const now = Date.now();
   let nextExpiry = Infinity;
   const values = new Map<string, string>();
   for (const [key, event] of entries) {
    if (event.expires_at <= now) { entries.delete(key); continue; }
    values.set(workspace ? event.channel_id : event.user.id, event.user.name);
    nextExpiry = Math.min(nextExpiry, event.expires_at);
   }
   setState(previous => previous.scope === scope && previous.values.size === values.size &&
    [...values].every(([key, name]) => previous.values.get(key) === name) ? previous : {scope, values});
   if (entries.size) timer = setTimeout(update, Math.max(1, nextExpiry - now));
  };
  const clear = () => { entries.clear(); update(); };
  clear();
  connection.on(workspace ? 'workspace.dm-typing' : 'chat.typing', (event: TypingEvent & {workspace_id?: string}) => {
   if (!event || (workspace ? event.workspace_id !== workspace : event.channel_id !== channel) ||
    event.thread_id !== (thread ?? null) || event.user?.id === viewerId || typeof event.channel_id !== 'string' ||
    typeof event.source_id !== 'string' || typeof event.user?.id !== 'string' || typeof event.user.name !== 'string' ||
    event.user.name.length > 200 || typeof event.active !== 'boolean' || !Number.isFinite(event.expires_at)) return;
   const key = event.channel_id + ':' + event.source_id;
   if (!event.active) entries.delete(key);
   else if (event.expires_at > Date.now()) {
    if (!entries.has(key) && entries.size >= 100) entries.delete(entries.keys().next().value!);
    entries.set(key, {...event, expires_at: Math.min(event.expires_at, Date.now() + TYPING_TTL_MS)});
   }
   update();
  });
  connection.on('disconnect', clear);
  connection.on('session.revoked', clear);
  connection.on('workspace.revoked', event => { if (workspace === event.workspace_id) clear(); });
  connection.on('channel.revoked', event => {
   for (const [key, entry] of entries) if (entry.channel_id === event.channel_id) entries.delete(key);
   update();
  });
  return () => { clearTimeout(timer); connection.release(); };
 }, [scope, workspace, channel, thread, viewerId, enabled]);
 return state.scope === scope && enabled ? state.values : emptyTyping;
}

export function useDirectTyping(workspace: string, viewerId: string) {
 return useTypingActivity({ workspace, viewerId });
}

export function TypingIndicator(props: {channel:string;thread?:string;viewerId:string;enabled?:boolean}){
 const users = [...useTypingActivity(props).values()];
 return <div className="chat-typing" role="status" aria-live="polite" aria-atomic="true">{users.length>2?'Several people are typing':users.length>0?<span><strong>{users[0]}</strong>{users.length===2?<> and <strong>{users[1]}</strong> are typing</>:' is typing'}</span>:null}</div>;
}
