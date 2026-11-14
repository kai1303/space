import {useEffect,useRef,useState} from 'react';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {Broom, CaretDown, Eraser, DotsThreeVertical, X} from '@phosphor-icons/react';
import {conversationPath,sessionMessagePath,isEmojiOnlyText,type HubMessage} from '@space/contracts';
import {Avatar,Button,Dialog,IconButton,ListRowSkeleton,Menu} from '@space/ui/primitives';
import {MAX_ITEMS,useCollection} from './useWorkspaceCollection.js';
import './saved-messages.css';

type Target={channel_id:string;message_id:string};
type Action='move'|'clear';
function SavedIntroduction({storageKey, disabled, onAction}: {
  storageKey: string;
  disabled: boolean;
  onAction: (action: Action) => void;
}) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  const reduced = useReducedMotion();
  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(storageKey, '1'); } catch { /* Session-only dismissal. */ }
  }
  return <AnimatePresence initial={false}>{!dismissed && <motion.div className="saved-intro-wrap"
    exit={{opacity: 0, height: 0}} transition={{duration: reduced ? 0 : .16}}>
    <section aria-label="About Saved" className="saved-intro">
      <span className="saved-new">New</span>
      <IconButton label="Dismiss Saved introduction" size="sm" onClick={dismiss}><X size={16}/></IconButton>
      <h2>To-dos is for tasks, and Saved is for everything else</h2>
      <p>Keep messages here for reference. When a message needs a follow-up, move it to To-dos. You can also clear your Saved list to start fresh.</p>
      <div className="saved-intro-actions">
        <Button variant="secondary" disabled={disabled} onClick={() => onAction('clear')}>Clear All Saved</Button>
        <button type="button" disabled={disabled} onClick={() => onAction('move')}>Move to To-dos</button>
      </div>
    </section>
  </motion.div>}</AnimatePresence>;
}

export function SavedMessages({workspace,viewer,onOpen}:{workspace:string;viewer?:string;onOpen:(t:Target)=>void}){
  const data=useCollection(workspace,'saved','',{viewer});
  const rows=data.items as HubMessage[];
  const [selected,select]=useState<string>(),[confirm,setConfirm]=useState<Action>();
  const [notice,setNotice]=useState<{text:string;undo?:Target}>();
  const [working,setWorking]=useState(false);
  const lastButton=useRef<HTMLButtonElement|null>(null);
  const active=rows.find(row=>row.id===selected);
  const reduce=useReducedMotion();
  const duration=reduce?0:.14;
  const path=(m:HubMessage)=>m.session_id&&m.task_id&&m.part?sessionMessagePath(m.session_id,m.task_id,m.part):conversationPath(m.channel_id,undefined,m.id);
  const target=(m:HubMessage)=>({channel_id:m.channel_id,message_id:m.id});
  const open=(m:HubMessage)=>path(m)?select(m.id):onOpen(target(m));
  function close(){select(undefined);lastButton.current?.focus();}
  useEffect(()=>{if(data.revoked){setNotice(undefined);setConfirm(undefined);select(undefined);}},[data.revoked]);
  async function clear(m:HubMessage){
    if(await data.change('/saved/'+m.id,{channel_id:m.channel_id,active:false})){
      setNotice({text:'Removed from Saved',undo:target(m)});
      if(selected===m.id)close();
    }
  }
  async function cleanup(action:Action,m?:HubMessage){
    setConfirm(undefined);setWorking(true);setNotice(undefined);
    try{
      let before:string|undefined;
      do{
        const page=await data.change<{count:number;before:string}>('/saved/cleanup',{action,...(m?{message_id:m.id}:{}),...(before?{before}:{})});
        if(!page)return;
        before=page.before;
        if(m || page.count<100)break;
      }while(true);
      setNotice({text:action==='move'?'Moved to To-dos':'Removed from Saved'});
    }finally{setWorking(false);}
  }
  const busy=data.busy||working;
  return <main id="chat-messages" tabIndex={-1} className="workspace-collection saved-page">
    <section className="saved-main" aria-label="Saved">
      <header className="saved-header"><h1>Saved</h1>{!!rows.length && !busy && <Menu floating label="Clean up" trigger={<><Broom size={16}/> <CaretDown size={12}/></>} items={[
        {label:'Move saved items to to-dos',onSelect:()=>setConfirm('move')},
        {label:'Remove all saved items',danger:true,onSelect:()=>setConfirm('clear')},
      ]}/>}</header>
      {data.error && <div role="alert" className="collection-error">{data.error} {!data.revoked&&<Button size="sm" onClick={()=>void data.retry()}>Retry</Button>}</div>}
      {data.writeError && <p role="alert" className="collection-error">{data.writeError}. Your change could not be confirmed.</p>}
      {data.loading && !rows.length && <ListRowSkeleton label="Loading saved items…" />}
      {!rows.length && !data.loading && !data.error && <div className="saved-empty">
        <img className="saved-illustration" src="/illustrations/saved-bookmark.svg" alt=""/>
        <h2>Nothing saved yet</h2><p>Save a message to keep it here.</p></div>}
      {!!rows.length && <div className="saved-scroll"><SavedIntroduction storageKey={'space:saved-intro:'+workspace+':'+viewer} disabled={busy} onAction={setConfirm}/><ul aria-label="Saved messages">{rows.map(m=>{
        const src=path(m), date=m.saved_at??m.created_at;
        return <motion.li key={m.id} initial={{opacity:reduce?1:0}} animate={{opacity:1}} transition={{duration}} data-selected={selected===m.id}>
          <button type="button" className="saved-open" aria-label={'View message in '+m.channel_name} onClick={e=>{lastButton.current=e.currentTarget;open(m);}}>
            <Avatar name={m.author_name} initials={m.author_name.slice(0,2).toUpperCase()} image={m.author_image} size="md"/>
            <span className="saved-copy">
              <span className="saved-preview" data-emoji={isEmojiOnlyText(m.text)}>{m.text||m.file_name||'Shared a file'}</span>
              <span className="saved-meta"><span><b>{m.author_name}</b>{viewer && m.author_id===viewer?' (you)':''} in {m.channel_kind==='direct'?'':'#'}{m.channel_name}</span>
                <time dateTime={date}>{new Date(date).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</time>
              </span>
            </span>
          </button>
          {!busy && <div className="saved-actions" role="group" aria-label="Saved message actions">
            <IconButton label={'Remove saved message from '+m.author_name} title="Clear" size="sm" onClick={()=>void clear(m)}><Eraser size={18}/></IconButton>
            <Menu floating label={'More actions for '+m.author_name} trigger={<DotsThreeVertical size={18}/>} items={[
              {label:'Move to to-dos',onSelect:()=>void cleanup('move',m)},
              {label:'Open in Home',onSelect:()=>m.session_id&&src?window.location.assign(src):onOpen(target(m))},
              {label:'Open in split view',onSelect:()=>open(m)},
              ...(src?[{label:'Open in new window',onSelect:()=>{window.open(src,'_blank','noopener,noreferrer');}}]:[]),
              {label:'Clear',separatorBefore:true,onSelect:()=>void clear(m)},
            ]}/></div>}
        </motion.li>;})}</ul>
        {data.cursor && (rows.length<MAX_ITEMS?<Button disabled={busy || data.loading} onClick={()=>void data.more()}>Load more</Button>:<p>Showing the first {MAX_ITEMS} saved messages.</p>)}</div>}
      {notice && !data.revoked && <div className="saved-notice" role="status">{notice.text}
        {notice.undo && <button disabled={busy} onClick={async()=>{const t=notice.undo!;if(await data.change('/saved/'+t.message_id,{channel_id:t.channel_id,active:true}))setNotice({text:'Added to Saved'});}}>Undo</button>}
        <IconButton size="sm" label="Dismiss notification" onClick={()=>setNotice(undefined)}><X size={14}/></IconButton></div>}
    </section>
    <AnimatePresence>{active && path(active) && <motion.aside className="space-channel-split saved-split" aria-label={'Split view of '+active.channel_name}
      initial={{opacity:reduce?1:0,x:reduce?0:12}} animate={{opacity:1,x:0}} exit={{opacity:0,x:reduce?0:12}} transition={{duration}}>
      <div className="saved-split-close"><IconButton label="Close split view" onClick={close}><X size={18}/></IconButton></div>
      <iframe key={active.id} title={'Conversation in '+active.channel_name} src={path(active)+(active.session_id?'&':'?')+'view=split&source=saved'}/></motion.aside>}</AnimatePresence>
    <Dialog open={!!confirm} title={confirm==='move'?'Move saved items to to-dos?':'Remove all saved items?'} onClose={()=>setConfirm(undefined)}>
      <p>{confirm==='move'?'Create a personal to-do for each saved message and remove it from Saved.':'This clears your Saved list. The original messages stay in their conversations.'}</p>
      <Button variant="secondary" onClick={()=>setConfirm(undefined)}>Cancel</Button>{' '}
      <Button onClick={()=>confirm && void cleanup(confirm)}>{confirm==='move'?'Move to To-dos':'Remove all'}</Button>
    </Dialog>
  </main>;
}
