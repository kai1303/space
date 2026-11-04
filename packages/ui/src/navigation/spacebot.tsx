import {useEffect,useId,useRef,useState,type SVGProps} from 'react';
import {useReducedMotion} from 'motion/react';
import {BotEngine,expressions,mixColor,notificationColor,shapes,frozenAt,poseDuration,type BotFrame,type BotState,type Dot} from './spacebot-engine.js';

const shapeNames=['circle','pebble','squircle','capsule','triangle','hexagon','cloud','droplet'] as const;
const faceNames=['neutral','attentive','surprised','excited','happy','laughing','angry','sad','scared','suspicious','confused','curious','proud','shy','unimpressed','sleepy'] as const;
export type SpacebotProps=Omit<SVGProps<SVGSVGElement>,'children'|'color'> & {
 size?:number;shape?:typeof shapeNames[number];expression?:typeof faceNames[number];color?:string;
 state?:BotState;playKey?:number;animated?:boolean;follow?:boolean;paper?:string;
};
export type {BotState} from './spacebot-engine.js';
const clamp=(value:number)=>Math.max(-1,Math.min(1,value));
const ease=(value:number)=>1-(1-Math.max(0,Math.min(1,value)))**5;

/** Grokbots geometry and timing, with animation owned entirely by this SVG. */
export function Spacebot({size=20,shape='circle',expression='attentive',color='#8b5cf6',state='idle',playKey=0,animated=true,follow=true,paper='var(--sp-surface,#0a0a0c)',style,...props}:SpacebotProps) {
 const id=useId(),mask=`${id}-mask`,fill=`${id}-fill`,svg=useRef<SVGSVGElement>(null);
 const shapeData=shapes[shapeNames.indexOf(shape)]??shapes[0]!;
 const faceData=expressions[faceNames.indexOf(expression)]??expressions[1]!;
 const engine=useRef<InstanceType<typeof BotEngine>|null>(null);
 if(!engine.current)engine.current=new BotEngine(100,'idle',shapeData.radii,faceData);
 const time=useRef(.35),pointer=useRef<{x:number;y:number}|null>(null),lastPointer=useRef(0),started=useRef<number|null>(null);
 const [frame,setFrame]=useState<BotFrame>(()=>engine.current!.sample(time.current));
 const reduced=useReducedMotion();
 const sample=()=>engine.current!.sample(time.current+((!animated||reduced)?Math.max(.45,frozenAt[engine.current!.state]):0));
 useEffect(()=>{engine.current!.setShape(shapeData.radii,time.current);engine.current!.setExpression(faceData,time.current);setFrame(sample());},[shapeData,faceData,animated,reduced]);
 useEffect(()=>{
  engine.current!.setState(state,time.current);
  if(!animated||reduced)engine.current!.setLook(null,time.current);
  setFrame(sample());
  if(state==='idle'||!animated||reduced)return;
  const deadline=setTimeout(()=>{engine.current!.setState('idle',time.current);setFrame(engine.current!.sample(time.current));},poseDuration(state)*1000);
  return()=>clearTimeout(deadline);
 },[state,playKey,animated,reduced]);
 useEffect(()=>{
  if(!animated||reduced)return;
  let raf=0,last=0,visible=true;
  let centre:{x:number;y:number}|null=null;
  const measure=()=>{const box=svg.current?.getBoundingClientRect();centre=box&&box.width>0&&box.height>0?{x:box.left+box.width/2+window.scrollX,y:box.top+box.height/2+window.scrollY}:null;};
  const move=(event:PointerEvent)=>{if(event.pointerType!=='touch'){pointer.current={x:event.clientX,y:event.clientY};lastPointer.current=performance.now();}};
  const leave=()=>{pointer.current=null;};
  const stop=()=>{if(raf)cancelAnimationFrame(raf);raf=0;last=0;};
  const tick=(now:number)=>{
   raf=requestAnimationFrame(tick);
   const urgent=now-lastPointer.current<600||engine.current!.state!=='idle';
   if(last&&now-last<48&&!urgent)return;
   time.current+=last?Math.min((now-last)/1000,.05):0;last=now;
   if(follow&&centre){
    if(started.current===null)started.current=time.current;
    const point=pointer.current;
    engine.current!.setLook({
     yaw:16*(point?clamp((point.x-(centre.x-window.scrollX))/Math.max(1,window.innerWidth/2)):0),
     pitch:-13*(point?clamp((point.y-(centre.y-window.scrollY))/Math.max(1,window.innerHeight/2)):0),
     mix:ease((time.current-started.current)/.85),spin:0,wander:point?0:1,
    },time.current);
   }
   setFrame(engine.current!.sample(time.current));
  };
  const resume=()=>{if(visible&&document.visibilityState!=='hidden'){if(!raf){measure();raf=requestAnimationFrame(tick);}}else stop();};
  const visibility=()=>resume();
  const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(([entry])=>{visible=!!entry?.isIntersecting;resume();},{rootMargin:'80px'});
  if(svg.current)observer?.observe(svg.current);
  const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
  if(svg.current)resize?.observe(svg.current);resize?.observe(document.documentElement);
  if(follow){window.addEventListener('pointermove',move,{passive:true});document.addEventListener('pointerleave',leave);}
  window.addEventListener('resize',measure,{passive:true});
  document.addEventListener('visibilitychange',visibility);resume();
  return()=>{stop();observer?.disconnect();resize?.disconnect();window.removeEventListener('pointermove',move);document.removeEventListener('pointerleave',leave);window.removeEventListener('resize',measure);document.removeEventListener('visibilitychange',visibility);};
 },[animated,reduced,follow]);
 const radius=158;
 const dots=(behind:boolean)=><g data-spacebot-dots={behind?'behind':'front'}>{frame.dotsBehind===behind&&frame.dots.map((dot,index)=><Particle key={index} dot={dot} color={color} paper={paper}/>)}</g>;
 return <svg ref={svg} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="-158 -158 316 316" aria-hidden="true" focusable="false" data-spacebot="" data-state={engine.current.state} style={{overflow:'visible',...style}} {...props}>
  <defs>
   <mask id={mask} maskUnits="userSpaceOnUse" x={-radius} y={-radius} width={radius*2} height={radius*2}>
    <path d={frame.bodyPath} fill="#fff"/>
    {frame.eyes.map((eye,index)=><path key={index} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="#000"/>)}
    {frame.notch&&<circle {...{cx:frame.notch.x,cy:frame.notch.y,r:frame.notch.r}} fill="#000"/>}
   </mask>
   <radialGradient id={fill} gradientUnits="userSpaceOnUse" cx={-.32*radius} cy={-.4*radius} r={1.55*radius}>
    <stop offset="0%" stopColor={mixColor(color,'#ffffff',.62)}/><stop offset="32%" stopColor={mixColor(color,'#ffffff',.2)}/><stop offset="72%" stopColor={color}/><stop offset="100%" stopColor={mixColor(color,'#0a0a0c',.4)}/>
   </radialGradient>
   {frame.arcs.map(arc=><linearGradient key={arc.id} id={`${id}-${arc.id}`} gradientUnits="userSpaceOnUse" x1={arc.grad.x1} y1={arc.grad.y1} x2={arc.grad.x2} y2={arc.grad.y2}>{arc.grad.stops.map((value,index)=><stop key={index} offset={arc.grad.stops.length===1?0:index/(arc.grad.stops.length-1)} stopColor={value}/>)}</linearGradient>)}
  </defs>
  <g fill="none" strokeLinecap="round">{frame.arcs.map(arc=><path key={arc.id} d={arc.back} stroke={`url(#${id}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity}/>)}</g>
  {dots(true)}
  <g opacity={frame.bodyAlpha}><path d={frame.bodyPath} fill={paper}/><g mask={`url(#${mask})`}><rect x={-radius} y={-radius} width={radius*2} height={radius*2} fill={`url(#${fill})`}/></g></g>
  {dots(false)}
  {frame.notif&&<circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={notificationColor}/>}
  <g fill="none" strokeLinecap="round">{frame.arcs.map(arc=><path key={arc.id} d={arc.front} stroke={`url(#${id}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity}/>)}</g>
 </svg>;
}
function Particle({dot,color,paper}:{dot:Dot;color:string;paper:string}) {
 const tint=dot.color??(dot.depth===undefined?color:mixColor(paper.startsWith('#')?paper:'#0a0a0c',color,dot.depth));
 return dot.d?<path d={dot.d} fill={tint} opacity={dot.opacity} transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot??0}) scale(100)`}/>:<circle cx={dot.x} cy={dot.y} r={dot.r} fill={tint} opacity={dot.opacity}/>;
}
