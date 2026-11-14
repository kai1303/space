import { Megaphone, Robot } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { PopoverSurface } from '../motion/popover-surface.js';
import { motionTransition } from '../motion/motion.js';
import type Quill from 'quill';
import type { MentionOption } from '@space/contracts';
export type FindMentions = (query: string) => Promise<{ items: MentionOption[]; member_count: number }>;
const mentionSearchDelayMs = 250;
type Match = { start: number; length: number; query: string; items: MentionOption[]; index: number; pending: boolean; hasResults: boolean; error?: string };
function MentionPopover({ id, match, reduced, children }: {
  id: string; match: Match; reduced: boolean | null; children: ReactNode;
}) {
  return <PopoverSurface id={id} className="sp-mention-suggestions" role="listbox"
    aria-label="Mention suggestions" aria-busy={match.pending}
    layout={!reduced} layoutDependency={match.items}
    style={{ originX: 0, originY: 1 }}>
    {children}
  </PopoverSurface>;
}

export function useMentions(editor: RefObject<Quill|null>, ready: boolean, channel: string, find?: FindMentions, editorVersion = 0, outsideLabel = 'Not in channel') {
  const reduced = useReducedMotion();
  const [match,setMatch]=useState<Match|null>(null),[memberCount,setMemberCount]=useState(0);
  const current=useRef(match),finder=useRef(find),epoch=useRef(0),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const id=useId();finder.current=find;
  const options=useRef<HTMLDivElement>(null);
  function update(next:Match|null){current.current=next;setMatch(next);}
  function close(){epoch.current++;clearTimeout(timer.current);update(null);}
  useEffect(()=>{
    close();
    const q=editor.current;if(!q||!ready||!find)return;
    const changed=()=>{
      const range=q.getSelection();if(!range||range.length){close();return;}
      const format=q.getFormat(range),previous=q.getFormat(Math.max(0,range.index-1),1);
      if(format.code||format['code-block']||format.blockquote||format.link||previous.mention){close();return;}
      const result=/(?:^|[\s([{])@([\p{L}\p{N}\p{M} _.-]{0,100})$/u.exec(q.getText(0,range.index));
      if(!result){close();return;}
      const query=result[1]!,start=range.index-query.length-1,length=query.length+1;
      if(q.getFormat(start,1).mention){close();return;}
      if(current.current?.start===start&&current.current.query===query)return;
      const version=++epoch.current;clearTimeout(timer.current);
      const prior = current.current?.start === start ? current.current : null;
      update({ start, length, query, items: prior?.items ?? [], index: prior?.index ?? 0,
        pending: true, hasResults: prior?.hasResults ?? false });
      timer.current=setTimeout(()=>{
        void finder.current?.(query).then(result=>{
          if(epoch.current!==version)return;
          setMemberCount(result.member_count);update({start,length,query,items:result.items,index:0,pending:false,hasResults:true});
        }).catch(()=>{if(epoch.current===version)update({start,length,query,items:[],index:0,pending:false,hasResults:false,error:'Could not find mentions. Try typing again.'});});
      }, mentionSearchDelayMs);
    };
    // Typing updates the caret silently after text-change; editor-change includes that update.
    q.on('editor-change',changed);
    return()=>{q.off('editor-change',changed);epoch.current++;clearTimeout(timer.current);};
  },[ready,channel,Boolean(find),editorVersion]);
  useEffect(()=>{
    const root=editor.current?.root;if(!root||!find)return;
    if(match){root.setAttribute('aria-controls',id);root.setAttribute('aria-expanded','true');if(!match.pending && match.items[match.index])root.setAttribute('aria-activedescendant',`${id}-${match.index}`);else root.removeAttribute('aria-activedescendant');}
    else {root.removeAttribute('aria-activedescendant');root.setAttribute('aria-expanded','false');}
  },[match,id,ready]);
  useEffect(()=>{options.current?.querySelector<HTMLElement>('[aria-selected=true]')?.scrollIntoView?.({block:'nearest'});},[match?.index,match?.items]);
  function choose(index:number){
    const q=editor.current,m=current.current,option=m?.items[index];if(!q||!m||m.pending||!option)return;
    const ref={kind:option.kind,id:option.id,label:option.label},value=`@${option.label}`;
    close();q.history.cutoff();q.focus();q.deleteText(m.start,m.length,'user');q.insertText(m.start,value,{mention:ref},'user');
    q.insertText(m.start+value.length,' ',{mention:false},'user');q.setSelection(m.start+value.length+1,0,'user');q.format('mention',false,'silent');q.history.cutoff();close();
  }
  function key(event:KeyboardEvent){
    if(event.isComposing||event.keyCode===229)return false;
    const m=current.current;
    if(m&&['ArrowDown','ArrowUp','Enter','Tab','Escape','Home','End'].includes(event.key)){
      if(!m.pending&&!m.items.length&&event.key!=='Escape')return false;
      event.preventDefault();event.stopImmediatePropagation();
      if(event.key==='Escape')close();else if(event.key==='Enter'||event.key==='Tab')choose(m.index);
      else if(!m.pending && m.items.length)update({...m,index:event.key==='Home'?0:event.key==='End'?m.items.length-1:(m.index+(event.key==='ArrowUp'?-1:1)+m.items.length)%m.items.length});
      return true;
    }
    const q=editor.current,range=q?.getSelection();
    if(q&&range&&!event.metaKey&&!event.ctrlKey&&['Backspace','Delete'].includes(event.key)){
      let at=0;
      for(const op of q.getContents().ops){const length=typeof op.insert==='string'?op.insert.length:1;
        if(op.attributes?.mention&&(!range.length?(event.key==='Backspace'?range.index>at&&range.index<=at+length:range.index>=at&&range.index<at+length):range.index<at+length&&range.index+range.length>at)){
          event.preventDefault();event.stopImmediatePropagation();const start=Math.min(range.index,at),end=Math.max(range.index+range.length,at+length);q.deleteText(start,end-start,'user');q.setSelection(start,0,'user');return true;
        }at+=length;
      }
    }
    return false;
  }
  function begin(){const q=editor.current;if(!q)return;q.focus();const range=q.getSelection()??{index:q.getLength()-1,length:0};const previous=q.getText(range.index-1,1),value=previous==='@'?'':previous&&!/\s/.test(previous)?' @':'@';q.deleteText(range.index,range.length,'user');q.insertText(range.index,value,{mention:false},'user');q.setSelection(range.index+value.length,0,'user');}
  const suggestions = <AnimatePresence>{match && <MentionPopover key="mentions" id={id} match={match} reduced={reduced}>
    <motion.div layoutScroll className="sp-mention-options" ref={options} role="presentation">
    {match.pending && !match.hasResults?<p role="status">Searching…</p>:match.error?<p role="alert">{match.error}</p>:!match.items.length?<p role="status">No matching people or agents</p>:match.items.map((option,index)=><motion.button
      layout={reduced ? false : 'position'} layoutDependency={match.items}
      initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={motionTransition(reduced, 0.12)}
      key={`${option.kind}:${option.id}`} id={`${id}-${index}`} type="button" role="option" aria-disabled={match.pending} aria-selected={!match.pending && index===match.index} onPointerMove={()=>{if(current.current && !current.current.pending && current.current.index!==index)update({...current.current,index});}} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(index)}>
      <span className="sp-mention-avatar" data-mention-kind={option.kind} aria-hidden="true">{option.image?<img src={option.image} alt=""/>:option.kind==='broadcast'?<Megaphone size={16}/>:option.kind==='agent'?<Robot size={16}/>:option.label.slice(0,2).toUpperCase()}</span>
      <span className="sp-mention-label"><strong>{option.kind==='broadcast'?'@':''}{option.label}</strong>{option.kind==='agent'&&<span className="sp-mention-agent-label">Agent</span>}</span>
      <small className="sp-mention-detail">{option.kind==='user'?`${option.detail||'Member'}${match.items.filter(item => item.kind === option.kind && item.label === option.label).length > 1 ? ` · ${option.id.slice(-8)}` : ''}`:option.kind==='agent'&&option.detail==='Agent'?'':option.detail}</small>
      {option.joined===false&&<small className="sp-mention-membership">{outsideLabel}</small>}
      <kbd className="sp-mention-select-hint" aria-hidden="true">Enter</kbd>
    </motion.button>)}
    </motion.div>
    <footer><span><kbd>↑ ↓</kbd> to navigate</span><span><kbd>↵</kbd> to select</span><span><kbd>esc</kbd> to dismiss</span></footer>
  </MentionPopover>}</AnimatePresence>;
  return {key,begin,suggestions,memberCount};
}
