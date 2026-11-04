import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {Spacebot} from './spacebot.js';
import {BotEngine,shapes,expressions} from './spacebot-engine.js';
const preference=vi.hoisted(()=>({reduced:false}));
vi.mock('motion/react',async original=>({...await original<typeof import('motion/react')>(),useReducedMotion:()=>preference.reduced}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();preference.reduced=false;});
function frames(){
 let index=0;const pending=new Map<number,FrameRequestCallback>();
 vi.stubGlobal('requestAnimationFrame',vi.fn((callback:FrameRequestCallback)=>{pending.set(++index,callback);return index;}));
 vi.stubGlobal('cancelAnimationFrame',vi.fn((id:number)=>pending.delete(id)));
 return {pending,tick:(time:number)=>act(()=>{const batch=[...pending.values()];pending.clear();batch.forEach(callback=>callback(time));})};
}
it('tracks the cursor and animates without rerendering its parent or replacing SVG nodes',()=>{
 const clock=frames();const parent=vi.fn();
 vi.spyOn(SVGElement.prototype,'getBoundingClientRect').mockReturnValue({x:100,y:100,left:100,top:100,right:200,bottom:200,width:100,height:100,toJSON(){}});
 function Parent(){parent();return <Spacebot/>;}
 const view=render(<Parent/>);const svg=view.container.querySelector('svg')!,eye=svg.querySelector('mask path:nth-child(2)')!;
 const original=eye.getAttribute('transform');clock.tick(0);
 fireEvent(window,Object.assign(new Event('pointermove'),{clientX:800,clientY:300,pointerType:'mouse'}));
 for(let time=16;time<400;time+=16)clock.tick(time);
 expect(eye.getAttribute('transform')).not.toBe(original);expect(parent).toHaveBeenCalledTimes(1);
 expect(view.container.querySelector('svg')).toBe(svg);expect(svg.querySelector('mask path:nth-child(2)')).toBe(eye);
 view.unmount();expect(clock.pending.size).toBe(0);
});
it('renders the purple clay geometry with unique mask and gradient references',()=>{
 preference.reduced=true;
 const view=render(<><Spacebot/><Spacebot/></>);
 const masks=[...view.container.querySelectorAll('mask')].map(el=>el.id);
 expect(new Set(masks).size).toBe(2);expect(view.container.querySelectorAll('radialGradient stop')).toHaveLength(8);
 expect(view.container.innerHTML).toContain('#8b5cf6');expect(view.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
});
it('does not start an animation loop for reduced motion',()=>{
 const clock=frames();preference.reduced=true;render(<Spacebot/>);expect(clock.pending.size).toBe(0);
});
it('changes animated poses in place and returns a transient pose to idle',()=>{
 vi.useFakeTimers();const clock=frames();const view=render(<Spacebot state="thinking"/>);
 clock.tick(0);for(let time=16;time<=600;time+=16)clock.tick(time);const svg=view.container.querySelector('svg')!;
 expect(svg.getAttribute('data-state')).toBe('thinking');expect(svg.querySelectorAll('[data-spacebot-dots] circle').length).toBeGreaterThan(0);
 act(()=>vi.advanceTimersByTime(2700));clock.tick(3000);
 expect(svg.getAttribute('data-state')).toBe('idle');
 view.rerender(<Spacebot state="wink"/>);expect(view.container.querySelector('svg')).toBe(svg);
});
it('pauses out of view and in a hidden document, then resumes and cleans up observers',()=>{
 const clock=frames();let intersect!:(entries:{isIntersecting:boolean}[])=>void;const disconnect=vi.fn();
 vi.stubGlobal('IntersectionObserver',class {constructor(callback:typeof intersect){intersect=callback;}observe(){}disconnect=disconnect;});
 const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
 const view=render(<Spacebot/>);expect(clock.pending.size).toBe(1);
 act(()=>intersect([{isIntersecting:false}]));expect(clock.pending.size).toBe(0);
 act(()=>intersect([{isIntersecting:true}]));expect(clock.pending.size).toBe(1);
 visibility.mockReturnValue('hidden');fireEvent(document,new Event('visibilitychange'));expect(clock.pending.size).toBe(0);
 visibility.mockReturnValue('visible');fireEvent(document,new Event('visibilitychange'));expect(clock.pending.size).toBe(1);
 view.unmount();expect(clock.pending.size).toBe(0);expect(disconnect).toHaveBeenCalled();
});

it('updates a reduced-motion shape immediately without starting frames',()=>{
 const clock=frames();preference.reduced=true;const view=render(<Spacebot shape="circle"/>);
 const original=view.container.querySelector('mask path')?.getAttribute('d');
 view.rerender(<Spacebot shape="squircle"/>);
 expect(view.container.querySelector('mask path')?.getAttribute('d')).not.toBe(original);expect(clock.pending.size).toBe(0);
});

it.each([['alert',2000],['orbit',2500],['burst',2400]] as const)('uses the source minimum playback deadline for %s', (state,milliseconds)=>{
 vi.useFakeTimers();frames();const view=render(<Spacebot state={state}/>);const svg=view.container.querySelector('svg')!;
 act(()=>vi.advanceTimersByTime(milliseconds-1));expect(svg.getAttribute('data-state')).toBe(state);
 act(()=>vi.advanceTimersByTime(1));expect(svg.getAttribute('data-state')).toBe('idle');
});
it('settles combined shape, face and pose changes when animation is disabled',()=>{
 frames();const view=render(<Spacebot animated={false}/>);const body=view.container.querySelector('mask path')!.getAttribute('d');
 view.rerender(<Spacebot animated={false} shape="cloud" expression="happy" state="wink"/>);
 expect(view.container.querySelector('mask path')!.getAttribute('d')).not.toBe(body);
 expect(view.container.querySelector('svg')!.getAttribute('data-state')).toBe('wink');
});

it('enters an initial pose from idle with the same first frame as Studio',()=>{
 frames();const source=new BotEngine(100,'idle',shapes[0]!.radii,expressions[1]);source.setState('wink',.35);
 const expected=source.sample(.35);const view=render(<Spacebot state="wink"/>);
 const eyes=[...view.container.querySelectorAll('mask path')].slice(1);
 expect(eyes.map(eye=>eye.getAttribute('transform'))).toEqual(expected.eyes.map(eye=>eye.matrix));
});
