import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';

const levels = ['Light', 'Medium', 'High', 'Extra High'];
const clampFraction = (value:number) => Math.min(1,Math.max(0,value));
const last = levels.length - 1;
const clamp = (position: number) => Math.max(0, Math.min(last, position));

export function CodexEffortSlider({ value, onChange }: {value: string; onChange:(value:string)=>void}) {
  const selected = Math.max(0, levels.indexOf(value));
  const [drag, setDrag] = useState<number | null>(null);
  const [showEnds, setShowEnds] = useState(false);
  const [hoverThumb,setHoverThumb] = useState(false);
  const slider = useRef<HTMLInputElement>(null);
  const gesture = useRef<{ id:number; x:number; offset:number; position:number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reduced = useReducedMotion();
  const step = Math.round(drag ?? selected);
  const positionValue = useMotionValue(selected / last);
  const percent = useTransform(positionValue, fraction => `${clampFraction(fraction)*100}%`);
  const enlarged = !reduced && (hoverThumb || drag!==null);
  useLayoutEffect(()=>{
    const target = (drag ?? selected) / last;
    if (reduced || drag!==null) { positionValue.jump(target); return; }
    const spring = animate(positionValue,target,{type:'spring',stiffness:300,damping:27,restDelta:.0001,restSpeed:.001});
    return ()=>spring.stop();
  },[selected,drag,reduced,positionValue]);

  useEffect(()=>()=>clearTimeout(timer.current),[]);
  useEffect(()=>{
    const element=slider.current;
    if (!element) return;
    let total=0, previous=0;
    function wheel(event:WheelEvent) {
      if (event.ctrlKey || gesture.current) return;
      event.preventDefault();
      const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY) ? event.deltaX : -event.deltaY;
      if (event.timeStamp-previous>160 || Math.sign(delta)!==Math.sign(total)) total=0;
      previous=event.timeStamp;
      total+=event.deltaMode===0 ? delta : 30*Math.sign(delta);
      if (Math.abs(total)<30) return;
      const direction=Math.sign(total);
      total-=30*direction;
      onChange(levels[clamp(Number(element!.value)+direction)]!);
    }
    element.addEventListener('wheel',wheel,{passive:false});
    return ()=>element.removeEventListener('wheel',wheel);
  },[onChange]);

  function position(event:PointerEvent<HTMLInputElement>) {
    const rect=event.currentTarget.getBoundingClientRect();
    return (event.clientX-rect.left-12)/Math.max(1,rect.width-24)*last;
  }
  function finish(commit:boolean) {
    if (!gesture.current) return;
    if (commit) onChange(levels[Math.round(gesture.current.position)]!);
    gesture.current=null;
    clearTimeout(timer.current);
    setShowEnds(false);
    setDrag(null);setHoverThumb(false);
  }
  return <div className="agent-power">
    <div className="agent-power-label">Reasoning effort <strong>{levels[step]}</strong></div>
    <div className="agent-power-control" data-dragging={drag!==null || undefined}>
      <div className="agent-power-track" aria-hidden="true">
        <div className="agent-power-rail">
          <motion.span className="agent-power-fill" style={{width:percent}}/>
          {levels.map((level,index)=><i key={level} data-filled={index<=step || undefined} style={{left:index/last*100+'%'}}/>)}
          <motion.span className="agent-power-thumb" style={{left:percent}}>
            <motion.span className="agent-power-grip" initial={false} animate={{scale:enlarged ? 32/28 : 1}}
              transition={reduced ? {duration:0} : {type:'spring',stiffness:enlarged ? 420 : 220,damping:enlarged ? 38 : 26}}/>
            {step===last && drag!==null && !reduced && <motion.span className="agent-power-burst" initial={{scale:.8,opacity:.8}} animate={{scale:1.7,opacity:0}} transition={{duration:.32,ease:'easeOut'}}/>}
          </motion.span>
        </div>
      </div>
      <input autoFocus ref={slider} type="range" min={0} max={last} step={1} value={step} aria-label="Reasoning effort" aria-valuetext={levels[step]}
        onChange={event=>{if (!gesture.current) onChange(levels[event.currentTarget.valueAsNumber]!);}}
        onPointerDown={event=>{
          if (!event.isPrimary || event.button!==0) return;
          event.preventDefault(); event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);
          const raw=position(event);
          const span=Math.max(1,event.currentTarget.clientWidth-24);
          const offset=Math.abs(raw-selected)*span/last<=10 ? raw-selected : 0;
          const start=clamp(raw-offset);
          gesture.current={id:event.pointerId,x:event.clientX,offset,position:start};
          setDrag(start);timer.current=setTimeout(()=>setShowEnds(true),150);
        }}
        onPointerMove={event=>{
          const active=gesture.current;
          if (!active) {
            const width=Math.max(1,event.currentTarget.clientWidth-24);
            setHoverThumb(event.pointerType!=='touch' && Math.abs(position(event)/last-positionValue.get())*width<=11);
            return;
          }
          if (active.id!==event.pointerId) return;
          active.position=clamp(position(event)-active.offset);setDrag(active.position);
          if (Math.abs(event.clientX-active.x)>=4) setShowEnds(true);
        }}
        onPointerLeave={()=>setHoverThumb(false)}
        onPointerUp={event=>{if(gesture.current?.id===event.pointerId) finish(true);}}
        onLostPointerCapture={()=>finish(false)} onPointerCancel={()=>finish(false)} onBlur={()=>finish(false)}/>
    </div>
    <motion.div className="agent-effort-endpoints" aria-hidden="true" initial={false} animate={{opacity:showEnds ? 1 : 0}} transition={{duration:reduced ? 0 : .12}}><span>{levels[0]}</span><span>{levels[last]}</span></motion.div>
  </div>;
}
