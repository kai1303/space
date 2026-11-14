import { useEffect, useRef, useState, type ReactNode } from 'react';
import { conversationPath, type HubThread, type HubThreadMessage } from '@space/contracts';
import { Button } from '@space/ui/primitives';
import { ArrowSquareOut, ChatCircle, ChatTeardropText, Hash } from '@phosphor-icons/react';
import { request } from '../../../shared/api/request.js';
import { subscribeUpdates } from '../../../shared/realtime/live-updates.js';
import { usePhoneLayout } from '../../../shared/ui/conversation-list.js';
import { ThreadPreviewMessage } from './ThreadPreviewMessage.js';
import { MAX_ITEMS, useCollection } from './useWorkspaceCollection.js';
import './thread-inbox.css';

type Target = {channel_id:string; thread_id?:string; message_id?:string};
export type ThreadDetail = (item: Pick<HubThread,'channel_id'|'thread_id'>, close: () => void) => ReactNode;
export type InlineComposer = (item:HubThread) => ReactNode;

function participantNames(item:HubThread, viewer?:string) {
  const people = new Map<string,string>();
  for (const person of [item.root?.author,...(item.participants ?? [])]) {
    if (person) people.set(person.id,person.name);
  }
  const includesYou = viewer && people.delete(viewer);
  const names = [...people.values()];
  if (includesYou && !names.length) return 'Just you';
  if (includesYou) names.push('you');
  return new Intl.ListFormat(undefined,{type:'conjunction'}).format(names);
}

function ThreadCard({item,workspace,viewer,inline,open,openSource,openConversation,refresh}:{
  item:HubThread; workspace:string; viewer?:string; inline?:ReactNode;
  open:(button:HTMLButtonElement)=>void; openSource:(message?:HubThreadMessage)=>void; openConversation:()=>void; refresh:()=>Promise<void>;
}) {
  const recent = item.recent_replies ?? [];
  const [pages,setPages] = useState(0);
  const [older,setOlder] = useState<HubThreadMessage[]>([]);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(false);
  const first = recent[0]?.sequence;
  const base = `/workspaces/${workspace}/hub/threads/${item.thread_id}`;
  useEffect(()=>{
    if (!pages || !first) return;
    const controller = new AbortController();
    let version=0;
    async function load() {
      const id=++version;
      let before=first;
      const messages:HubThreadMessage[]=[];
      setLoading(true);
      try {
        for (let n=0; n<pages && before; n++) {
          const page=await request<{items:HubThreadMessage[]}>(`${base}/replies?before=${encodeURIComponent(before)}`,undefined,undefined,'POST',controller.signal,viewer);
          if (controller.signal.aborted || id!==version) return;
          messages.unshift(...page.items);
          if (page.items.length<50) break;
          before=page.items[0]?.sequence;
        }
        setOlder(messages); setError('');
      } catch { if (!controller.signal.aborted && id===version) {setOlder([]); setError('Earlier replies could not be loaded.');} }
      finally {if (!controller.signal.aborted && id===version) setLoading(false);}
    }
    const stop=subscribeUpdates('workspace',workspace,load);
    const stopActor=viewer ? subscribeUpdates('actor',viewer,load) : undefined;
    return ()=>{controller.abort();stop();stopActor?.();};
  },[base,workspace,viewer,pages,first]);
  const replies=[...new Map([...older,...recent].map(m=>[m.id,m])).values()];
  const unread = (message:HubThreadMessage) => item.unread_count>0 && message.author.id!==viewer && BigInt(message.sequence ?? '0')>BigInt(item.read_through ?? '0');
  const firstUnread = replies.findIndex(unread);
  const hidden=Math.max(0,item.reply_count-replies.length);
  const ack=useRef('');
  function read() {
    if (!viewer || !item.unread_count || ack.current===item.latest_sequence) return;
    const seq=item.latest_sequence;
    ack.current=seq;
    void request(base+'/read',{sequence:seq},undefined,'POST',undefined,viewer).catch(()=>{ack.current='';});
  }
  const link=conversationPath(item.channel_id,item.thread_id);
  function preview(message:HubThreadMessage|undefined,root:boolean) {
    return <ThreadPreviewMessage key={message?.id ?? item.id} workspace={workspace} viewer={viewer} refresh={refresh}
      name={message?.author.name ?? item.author_name} date={message?.created_at ?? item.created_at}
      text={message?.text ?? item.text} message={message} onSource={()=>openSource(message)}
      onUnread={!root && message?.sequence && message.author.id!==viewer ? async ()=>{
        await request(base+'/unread',{sequence:message.sequence},undefined,'POST',undefined,viewer);
        ack.current=''; await refresh();
      } : undefined}
      onUnfollow={async ()=>{
        await request(`/threads/${item.thread_id}/notification-subscription`,{following:false},undefined,'PATCH',undefined,viewer);
        await refresh();
      }}/>;
  }
  return <article className="thread-feed-card">
    <header className="thread-card-heading">
      <button type="button" className="thread-source" title="Open thread in conversation" onClick={openConversation}>
        {item.channel_kind==='direct'?<ChatCircle size={16}/>:<Hash size={16}/>} {item.channel_name}
      </button>
      <span className="thread-participants">{participantNames(item,viewer)}</span>
      {link && <a className="thread-window-link" href={link+'?threadWindow=1'} target="_blank" rel="noopener noreferrer" aria-label="Open thread in a new window"><ArrowSquareOut size={16}/></a>}
    </header>
    <div className="thread-card-messages">
    {preview(item.root,true)}
    {hidden>0 && pages<10 && <button className="thread-show-more" disabled={loading} onClick={()=>setPages(n=>Math.min(n+1,10))}>
      {loading?'Loading replies…':`Show ${hidden} more ${hidden===1?'reply':'replies'}`}
    </button>}
    {pages>=10 && hidden>0 && <button onClick={openConversation}>Open full conversation</button>}
    {error && <span role="alert">{error}</span>}
    {replies.map((message,index)=><div key={message.id} className={unread(message)?'thread-new-reply':undefined}>
      {index===firstUnread && <span className="sp-sr-only">New replies</span>}
      {preview(message,false)}
    </div>)}
    {inline ? <div onFocusCapture={read} onClick={read}>{inline}</div> :
      <button className="thread-open" aria-label={'Open thread in '+item.channel_name} onClick={event=>open(event.currentTarget)}>Reply…</button>}
    </div>
  </article>;
}

export function ThreadInbox({workspace,viewer,onOpen,renderThread,renderComposer}:{
  workspace:string; viewer?:string; renderThread?:ThreadDetail; renderComposer?:InlineComposer; onOpen:(item:Target)=>void;
}) {
  const data=useCollection(workspace,'threads','',{viewer});
  const phone=usePhoneLayout();
  const [selected,select]=useState<Pick<HubThread,'channel_id'|'thread_id'>>();
  const origin=useRef<HTMLButtonElement|null>(null);
  const detail=selected && !data.revoked && (phone || !renderComposer);
  function close() {
    select(undefined);
    requestAnimationFrame(()=>(origin.current?.isConnected ? origin.current : document.getElementById('chat-messages'))?.focus({preventScroll:true}));
  }
  const hasInlineComposer = !!renderComposer;
  useEffect(()=>{if (!phone && hasInlineComposer) select(undefined);},[phone,hasInlineComposer]);
  return <main id="chat-messages" tabIndex={-1} className={'workspace-collection threads-inbox'+(detail?' has-detail':'')}>
    <section className="collection-main" aria-label="Threads"><header className="collection-heading"><ChatTeardropText size={21}/><h1>Threads</h1></header>
      {data.error && <div className="collection-error" role="alert">{data.error} {!data.revoked && <Button size="sm" onClick={()=>void data.retry()}>Retry</Button>}</div>}
      {!data.items.length && !data.loading && !data.error && <div className="collection-empty"><span><ChatTeardropText size={38}/></span><h2>Your threads, together</h2><p>Follow a thread or join a conversation. Its replies will appear here.</p></div>}
      {(data.items as HubThread[]).map(item=><ThreadCard key={item.id} item={item} workspace={workspace} viewer={viewer} refresh={data.refresh}
        inline={phone ? undefined : renderComposer?.(item)}
        openConversation={()=>onOpen({channel_id:item.channel_id,thread_id:item.thread_id})}
        openSource={message=>onOpen({channel_id:item.channel_id,message_id:message?.id ?? item.id})}
        open={button=>{const target={channel_id:item.channel_id,thread_id:item.thread_id}; if (!renderThread) return onOpen(target); origin.current=button;select(target);}}/>)}
      {data.loading && !data.items.length && <p role="status" className="collection-loading">Loading threads…</p>}
      {data.cursor && !data.loading && !data.error && <div className="collection-more">{data.items.length<MAX_ITEMS?<Button onClick={()=>void data.more()}>Load more</Button>:'Open a conversation to find older replies.'}</div>}
    </section>
    {detail && renderThread && <div className="thread-inbox-detail" key={selected.thread_id}>{renderThread(selected,close)}</div>}
  </main>;
}
