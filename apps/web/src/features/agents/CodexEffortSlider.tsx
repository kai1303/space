import { effortLabel } from '@space/contracts';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';

const clampFraction = (value:number) => Math.min(1,Math.max(0,value));
const thumbRadius = 13;

const sparks = Array.from({ length: 16 }, (_, index) => {
  const angle = index * Math.PI / 8;
  const distance = [33, 26, 36, 30][index % 4]!;
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
});

const trackParticles = Array.from({ length: 14 }, (_, index) => {
  const phase = index * 2.4;
  // Sample a closed orbit so particles keep moving through the loop boundary.
  const orbit = Array.from({ length: 25 }, (_, frame) => phase + frame * Math.PI / 12);
  return {
    left: `${5 + index * 7}%`,
    size: 1.6 + (index % 4) * 0.35,
    opacity: 0.4 + (index % 5) * 0.1,
    x: orbit.map(angle => 4 * Math.cos(angle)),
    y: orbit.map(angle => 6 * Math.sin(angle)),
    duration: 4.8 + (index % 5) * 0.55,
  };
});

export function CodexEffortSlider({ levels, value, onChange }: {levels:string[]; value: string; onChange:(value:string)=>void}) {
  const last = levels.length - 1;
  const clamp = (position:number) => Math.max(0,Math.min(last,position));
  const selected = Math.max(0, levels.indexOf(value));
  const [drag, setDrag] = useState<number | null>(null);
  const [showEnds, setShowEnds] = useState(false);
  const [hoverThumb,setHoverThumb] = useState(false);
  const slider = useRef<HTMLInputElement>(null);
  const gesture = useRef<{ id:number; x:number; offset:number; position:number; moved:boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reduced = useReducedMotion();
  const step = Math.round(drag ?? selected);
  const atMaximum = step === last;
  // Reopening at the model's highest effort shows the settled gradient.
  const [visitedLowerEffort, setVisitedLowerEffort] = useState(!atMaximum);
  useLayoutEffect(() => {
    if (!atMaximum) setVisitedLowerEffort(true);
  }, [atMaximum]);
  const animateEntry = visitedLowerEffort && !reduced;
  const positionValue = useMotionValue(selected / last);
  const percent = useTransform(positionValue, fraction => `${clampFraction(fraction)*100}%`);
  const enlarged = !reduced && (hoverThumb || drag!==null);
  useLayoutEffect(()=>{
    const target = (drag ?? selected) / last;
    if (reduced || gesture.current?.moved) { positionValue.jump(target); return; }
    const spring = animate(positionValue,target,{type:'spring',stiffness:300,damping:27,restDelta:.0001,restSpeed:.001});
    return ()=>spring.stop();
  },[selected,drag,reduced,positionValue,last]);

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
  },[onChange,levels,last]);

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
    <div className="agent-power-label">Reasoning effort <strong>{effortLabel(levels[step]!) || 'Default'}</strong></div>
    <div className="agent-power-control" data-dragging={drag!==null || undefined}>
      <div className="agent-power-track" aria-hidden="true">
        <div className="agent-power-rail">
          <motion.span className="agent-power-fill" style={{width:percent}}>
            <AnimatePresence initial={false}>
            {atMaximum && <motion.span className="agent-power-max-fill"
              initial={animateEntry ? { maskPosition: '0% 50%', opacity: 0 } : false}
              animate={{ maskPosition: '100% 50%', opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.18 } }}
              transition={{ maskPosition: { duration: animateEntry ? 1.6 : 0, ease: 'easeInOut' },
                opacity: { duration: animateEntry ? 0.18 : 0 } }}>
              <motion.span className="agent-power-max-color"
                animate={{ x: reduced ? '0%' : ['0%', '-20%'] }}
                transition={reduced ? { duration: 0 } : { duration: 4, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut' }}/>
              {!reduced && trackParticles.map(({ left, size, opacity, x, y, duration }) => (
                <motion.span key={left} className="agent-power-track-particle"
                  style={{ left, width: size, height: size, opacity }}
                  animate={{ x, y }}
                  transition={{ duration, repeat: Infinity, ease: 'linear' }}/>
              ))}
            </motion.span>}
            </AnimatePresence>
          </motion.span>
          {levels.map((level,index)=><i key={level} data-filled={index<=step || undefined} style={{left:index/last*100+'%'}}/>)}
          <motion.span className="agent-power-thumb" style={{left:percent}}>
            <motion.span className="agent-power-grip" initial={false} animate={{scale:enlarged ? 32/28 : 1}}
              transition={reduced ? {duration:0} : {type:'spring',stiffness:enlarged ? 420 : 220,damping:enlarged ? 38 : 26}}/>
            {atMaximum && animateEntry && sparks.map(({ x, y }, index) => (
              <motion.span key={index} className="agent-power-spark"
                initial={{ x: x * 0.35, y: y * 0.35, opacity: 0, scale: 0.35 }}
                animate={{ x, y, opacity: [0, 0.95, 0], scale: [0.35, 1, 0.45] }}
                transition={{ duration: 0.62, delay: (index % 4) * 0.004, times: [0, 0.22, 1], ease: 'easeOut' }}/>
            ))}
          </motion.span>
        </div>
      </div>
      <input autoFocus ref={slider} type="range" min={0} max={last} step={1} value={step} aria-label="Reasoning effort" aria-valuetext={effortLabel(levels[step]!) || 'Default'}
        onChange={event=>{if (!gesture.current) onChange(levels[event.currentTarget.valueAsNumber]!);}}
        onPointerDown={event=>{
          if (!event.isPrimary || event.button!==0) return;
          event.preventDefault(); event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);
          const raw=position(event);
          const span=Math.max(1,event.currentTarget.clientWidth-24);
          const offset=Math.abs(raw-selected)*span/last<=thumbRadius ? raw-selected : 0;
          const start=Math.round(clamp(raw-offset));
          gesture.current={id:event.pointerId,x:event.clientX,offset,position:start,moved:false};
          setDrag(start);timer.current=setTimeout(()=>setShowEnds(true),150);
        }}
        onPointerMove={event=>{
          const active=gesture.current;
          if (!active) {
            const width=Math.max(1,event.currentTarget.clientWidth-24);
            setHoverThumb(event.pointerType!=='touch' && Math.abs(position(event)/last-positionValue.get())*width<=thumbRadius);
            return;
          }
          if (active.id!==event.pointerId) return;
          if (!active.moved && Math.abs(event.clientX-active.x)<4) return;
          active.moved=true;
          active.position=clamp(position(event)-active.offset);setDrag(active.position);
          setShowEnds(true);
        }}
        onPointerLeave={()=>setHoverThumb(false)}
        onPointerUp={event=>{if(gesture.current?.id===event.pointerId) finish(true);}}
        onLostPointerCapture={()=>finish(false)} onPointerCancel={()=>finish(false)} onBlur={()=>finish(false)}/>
    </div>
    <motion.div className="agent-effort-endpoints" aria-hidden="true" initial={false} animate={{opacity:showEnds ? 1 : 0}} transition={{duration:reduced ? 0 : .12}}><span>{effortLabel(levels[0]!) || 'Default'}</span><span>{effortLabel(levels[last]!)}</span></motion.div>
  </div>;
}
