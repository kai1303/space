import { useState, type ComponentProps, type ReactNode } from 'react';
import type { SessionInput } from '@space/contracts';
import { motionTransition } from '@space/ui/motion/motion';
import { Button, Dialog, Menu } from '@space/ui/primitives';
import { ArrowBendUpRight, CaretDown, DotsSixVertical, DotsThree, ListBullets, Pause, X } from '@phosphor-icons/react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';

export type FollowUp = 'steer' | 'queue';
export function useFollowUpPreference() {
  const [mode,setMode]=useState<FollowUp>(()=>localStorage.getItem('space.agent.followUp')==='queue'?'queue':'steer');
  return [mode,(next:FollowUp)=>{localStorage.setItem('space.agent.followUp',next);setMode(next);}] as const;
}
export function FollowUpMenu({mode,change}:{mode:FollowUp;change:(value:FollowUp)=>void}) {
  const modifier=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘':'Ctrl';
  return <Menu label="Follow-up behavior" floating trigger={<CaretDown size={12}/>} items={[
    {label:`Queue · ${mode==='queue'?'Enter':modifier+'+Enter'}`,onSelect:()=>change('queue')},
    {label:`Steer · ${mode==='steer'?'Enter':modifier+'+Enter'}`,onSelect:()=>change('steer')},
  ]}/>;
}

const collapsed = { height: 0, opacity: 0 };
const expanded = { height: 'auto', opacity: 1 };

function QueuePanel({children}:{children:ReactNode}) {
  const present=useIsPresent(), reduced=useReducedMotion();
  return <motion.section className="agent-turn-inputs" aria-label="Message queue" inert={!present}
    initial={reduced ? false : collapsed} animate={expanded} exit={collapsed}
    transition={motionTransition(reduced)}>{children}</motion.section>;
}

function QueueRow({children,...drag}:Pick<ComponentProps<'li'>,'onDrop'|'onDragOver'|'children'>) {
  const present=useIsPresent(), reduced=useReducedMotion();
  return <motion.li layout={reduced?false:'position'} inert={!present} {...drag}
    initial={reduced ? false : collapsed} animate={expanded} exit={collapsed}
    transition={motionTransition(reduced)}>
    <div className="agent-turn-input">{children}</div>
  </motion.li>;
}

export type QueueAction = 'cancel'|'retry'|'move'|'edit'|'steer';
export function SessionQueue({items,canManage,pending,onAction,canSteer,paused,onResume,mode,onModeChange}:{
  items:SessionInput[]; canManage:(item:SessionInput)=>boolean; pending?:boolean; canSteer:boolean;
  onAction:(item:SessionInput,action:QueueAction,value?:string)=>Promise<boolean>|boolean;
  paused?:boolean; onResume?:()=>void; mode:FollowUp; onModeChange?:(value:FollowUp)=>void;
}) {
  const [edit,setEdit]=useState<SessionInput>(),[draft,setDraft]=useState(''),[preview,setPreview]=useState<SessionInput>();
  return <><AnimatePresence initial={false}>{items.length>0 && <QueuePanel key="queue">
    {paused && <div className="agent-queue-paused"><Pause size={14}/>Queue paused{onResume && <button disabled={pending} onClick={onResume}>Resume</button>}</div>}
    <motion.ol layoutScroll aria-label="Queued messages"><AnimatePresence initial={false}>{items.map((item,index)=>{
      const manage=canManage(item),move=(target:SessionInput)=>void onAction(item,'move',target.id);
      const label=item.text || `${item.file_count??1} attached ${item.file_count===1?'file':'files'}`;
      return <QueueRow key={item.id}
        onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-space-queued-message'))event.preventDefault();}}
        onDrop={event=>{event.preventDefault();const from=items.find(row=>row.id===event.dataTransfer.getData('application/x-space-queued-message'));
          if(!pending&&from&&from!==item&&canManage(from)) void onAction(from,'move',item.id);}}>
        <span className="agent-queue-grip" aria-hidden="true" draggable={items.length>1&&manage&&!pending}
          onDragStart={e=>e.dataTransfer.setData('application/x-space-queued-message',item.id)}>{items.length>1 ? <DotsSixVertical size={16}/> : <ListBullets size={14}/>}</span>
        <button type="button" className="agent-queue-preview" aria-label={`Preview queued message ${index+1}: ${label.slice(0,80)}`} onClick={()=>setPreview(item)}>{label}</button>
        {item.state==='blocked' && <small title={item.detail??undefined}>Paused</small>}
        {manage && item.state==='blocked' && <button disabled={pending} onClick={()=>void onAction(item,'retry')}>Retry</button>}
        {canSteer && item.state==='pending' && !item.file_count && <button className="agent-queue-steer" disabled={pending} title="Send to the current turn" onClick={()=>void onAction(item,'steer')}><ArrowBendUpRight size={13}/>Steer</button>}
        {manage && <><button aria-label="Delete queued message" disabled={pending} onClick={()=>void onAction(item,'cancel')}><X size={14}/></button>
          {!pending && <Menu label="Queued message actions" floating trigger={<DotsThree size={18} weight="bold"/>} items={[
            {label:'Edit message',onSelect:()=>{setEdit(item);setDraft(item.text);}},
            ...(index>0?[{label:'Move up',onSelect:()=>move(items[index-1]!)}]:[]),
            ...(index+1<items.length?[{label:'Move down',onSelect:()=>move(items[index+1]!)}]:[]),
            ...(onModeChange?[{label:mode==='queue'?'Turn off queueing':'Turn on queueing',onSelect:()=>onModeChange(mode==='queue'?'steer':'queue')}]:[]),
          ]}/>}</>}
      </QueueRow>;
    })}</AnimatePresence></motion.ol>
  </QueuePanel>}</AnimatePresence>
    {preview && items.some(item=>item.id===preview.id) && <Dialog open title="Queued message preview" onClose={()=>setPreview(undefined)}><p className="agent-queue-full">{preview.text || 'Attached files'}</p></Dialog>}
    {edit && items.some(item=>item.id===edit.id) && <Dialog open title="Edit queued message" onClose={()=>setEdit(undefined)}><form className="agent-goal-editor" onSubmit={async e=>{e.preventDefault();if(await onAction(edit,'edit',draft.trim()))setEdit(undefined);}}>
      <label>Message<textarea autoFocus maxLength={4000} value={draft} onChange={e=>setDraft(e.target.value)}/></label>
      <div className="agent-composer-buttons"><Button type="button" onClick={()=>setEdit(undefined)}>Cancel</Button><Button type="submit" disabled={pending||!draft.trim()}>Save</Button></div>
    </form></Dialog>}
  </>;
}

export function SteeringReceipt({item}:{item:SessionInput}) {
  const label=item.state==='blocked'?'Steering declined':item.state==='sending'?'Sending instruction…':'Steering unconfirmed';
  return <div className="agent-session-system-notice"><ArrowBendUpRight size={15}/><div><small>{label}</small><div>{item.text}</div>{item.detail&&<small>{item.detail}</small>}</div></div>;
}
