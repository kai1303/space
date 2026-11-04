import { useEffect, useState } from 'react';
import { Button, RichContent } from '@space/ui';
import { PencilSimple } from '@phosphor-icons/react';
import type { ChannelSummary } from '@space/contracts';
import { request } from './chat-client.js';
import type { ComposerDrafts as Drafts } from './composer-drafts.js';
import { WorkspaceCollections } from './WorkspaceCollections.js';

type Props = { workspace: string; drafts: Drafts; onOpen: (item: {channel_id:string;message_id?:string;thread_id?:string}) => void; onNewMessage: () => void };
export function ComposerDrafts({workspace,drafts,onOpen,onNewMessage}:Props) {
  const [tab,setTab] = useState('drafts');
  const [items,setItems] = useState<{key:string;channel:ChannelSummary;thread?:string}[]>([]);
  const [loading,setLoading] = useState(true),[error,setError] = useState(''),[retry,setRetry] = useState(0);
  useEffect(() => {
    let active=true;
    setItems([]);setLoading(true);setError('');
    const entries=Object.entries(drafts).filter(([,doc])=>doc.ops.some(op=>op.insert.trim())).slice(-100);
    void (async()=>{
      const found: typeof items=[];let failure=false;
      for(let i=0;i<entries.length;i+=4) {
        await Promise.all(entries.slice(i,i+4).map(async([key])=>{
          const [,threadChannel,thread]=key.split(':'); const id=key.startsWith('thread:')?threadChannel:key;
          try {const channel=await request<ChannelSummary>(`/channels/${id}`);if(channel.workspace_id===workspace&&channel.joined)found.push({key,channel,thread});}
          catch(reason){if(!(reason instanceof Error&&['not_found','forbidden','unauthorized'].includes(reason.message)))failure=true;}
        }));
        if(!active)return;
      }
      if(active){setItems(found);setLoading(false);setError(failure?'Some drafts could not be loaded. Try again.':'');}
    })();
    return()=>{active=false;};
  },[workspace,drafts,retry]);
  return <section className="composer-drafts"><header><h1>Drafts & sent</h1></header><div role="tablist" aria-label="Outgoing messages">{([['drafts','Drafts'],['scheduled','Scheduled'],['sent','Sent']] as const).map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    {tab==='sent'?<WorkspaceCollections view="sent" workspace={workspace} onOpen={onOpen}/>:tab==='scheduled'?<main id="chat-messages" tabIndex={-1} className="composer-drafts-empty"><PencilSimple size={40}/><h2>No scheduled messages</h2><p>Message scheduling isn’t available in Space yet. Keep a draft and send it when you’re ready.</p></main>:<main id="chat-messages" tabIndex={-1} className="composer-drafts-body">{error&&<p role="alert">{error}<Button onClick={()=>setRetry(n=>n+1)}>Retry</Button></p>}{loading?<p role="status">Loading drafts…</p>:items.length?<><p className="composer-drafts-hint">Drafts are saved in this browser. Select one to continue writing.</p><ul>{items.map(item=><li key={item.key}><button onClick={()=>onOpen({channel_id:item.channel.id,...(item.thread?{thread_id:item.thread}:{})})}><strong>{item.channel.kind==='direct'?'':'#'}{item.channel.name}{item.thread?' · Thread':''}</strong><RichContent document={drafts[item.key]!}/><span>Continue editing →</span></button></li>)}</ul></>:<div className="composer-drafts-empty"><PencilSimple size={46}/><h2>Draft messages to send when you’re ready</h2><p>Start typing a message anywhere, then find it here. Re-read, revise, and send whenever you’d like.</p><Button onClick={onNewMessage}>New message</Button></div>}</main>}
  </section>;
}
