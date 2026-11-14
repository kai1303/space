import { useEffect, useState } from 'react';
import { File, LinkSimple } from '@phosphor-icons/react';
import { assetDownloadPath, type Page, type SessionResourceMessage } from '@space/contracts';
import { Button } from '@space/ui/primitives';
import { safeLink } from '@space/ui/rich-text';
import { request } from '../../shared/api/request.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import './session-shared-resources.css';

type Props = {session:string; thread:string; viewer:string};

export function SessionSharedResources(props: Props) {
  return <ResourcePage key={props.session+props.viewer} {...props}/>;
}

function ResourcePage({session,thread,viewer}: Props) {
  const [before,setBefore] = useState('');
  const [result,setResult] = useState<{url:string;page?:Page<SessionResourceMessage>;error?:string}>();
  const [retry,setRetry] = useState(0);
  const url = '/agent-sessions/'+session+'/resources'+(before ? '?before='+encodeURIComponent(before) : '');
  useEffect(()=>{
    const controller = new AbortController();
    const stop = subscribeUpdates('thread',thread,async ()=>{
      try {
        const page = await request<Page<SessionResourceMessage>>(url,undefined,undefined,'POST',controller.signal,viewer);
        if (!controller.signal.aborted) setResult({url,page});
      } catch {
        if (!controller.signal.aborted) setResult({url,error:'Could not load shared files and links.'});
      }
    },()=>{
      controller.abort();
      setResult({url,error:'These files and links are no longer available.'});
    });
    return ()=>{controller.abort();stop();};
  },[url,thread,viewer,retry]);
  const page = result?.url===url ? result.page : undefined;
  return <section className="session-shared-resources" aria-label="Files and links shared in messages">
    {result?.url===url && result.error ? <p role="alert">{result.error} <Button size="sm" onClick={()=>setRetry(retry+1)}>Retry</Button></p>
      : !page ? <p role="status">Loading files and links…</p>
      : !page.items.length && <p>{before || page.next_cursor ? 'No available files or links on this page.' : 'No files or links shared in messages yet.'}</p>}
    {page?.items.map(item=><div key={item.id} className="session-resource-group">
      <small>{item.author} · {new Date(item.created_at).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}</small>
      {item.files.map(file=><a key={file.id} href={assetDownloadPath(file.id)} download={file.name}><File size={16}/>{file.name}</a>)}
      {item.links.map(link=>{
        const href=safeLink(link);
        return href && /^https?:/i.test(href) ? <a key={link} href={href} target="_blank" rel="noopener noreferrer"><LinkSimple size={16}/>{link}</a> : null;
      })}
    </div>)}
    <div className="session-resources-paging">
      {before && <Button size="sm" onClick={()=>setBefore('')}>Newest shares</Button>}
      {page?.next_cursor && <Button size="sm" onClick={()=>setBefore(page.next_cursor!)}>Older shares</Button>}
    </div>
  </section>;
}
