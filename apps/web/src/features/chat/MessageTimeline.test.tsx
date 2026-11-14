import {createRef,StrictMode} from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {MessageTimeline, type TimelineHandle} from './MessageTimeline.js';
import type {ChatEvent,MessagePage} from '@space/contracts';

const mocks=vi.hoisted(()=>({scrollToEnd:vi.fn(),scrollToIndex:vi.fn(),scrollToOffset:vi.fn(),reduced:false}));
vi.mock('motion/react',async original=>({...await original<typeof import('motion/react')>(),useReducedMotion:()=>mocks.reduced}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:(options:any)=>({getVirtualItems:()=>Array.from({length:options.count},(_,index)=>({index,key:options.getItemKey(index),start:index*100})),getTotalSize:()=>options.count*100,getOffsetForIndex:(index:number)=>[index*100,'center'],scrollToEnd:mocks.scrollToEnd,scrollToIndex:mocks.scrollToIndex,scrollToOffset:mocks.scrollToOffset,measureElement:()=>{}})}));
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();mocks.reduced=false;});

it('reissues the initial latest scroll after a StrictMode effect remount',()=>{
 const pinned=createRef<boolean>();pinned.current=true;
 render(<StrictMode><MessageTimeline label="Messages" items={[]} page={null} loading={null} latestVersion={1} load={()=>{}} pinned={pinned} render={()=>null}/></StrictMode>);
 // The virtualizer cancels in-flight scrolling in its effect cleanup.
 expect(mocks.scrollToEnd).toHaveBeenCalledTimes(2);
});

it('waits until a hidden conversation is visible before consuming its latest position',()=>{
 const pinned=createRef<boolean>();pinned.current=true;
 const timeline=(hidden:boolean)=><MessageTimeline label="Messages" items={[]} page={null} loading={null} latestVersion={1} hidden={hidden} load={()=>{}} pinned={pinned} render={()=>null}/>;
 const view=render(timeline(true));
 expect(mocks.scrollToEnd).not.toHaveBeenCalled();
 view.rerender(timeline(false));
 expect(mocks.scrollToEnd).toHaveBeenCalledTimes(1);
 const scroller=screen.getByLabelText('Messages');
 Object.defineProperties(scroller,{scrollHeight:{value:400},clientHeight:{value:100}});
 fireEvent.scroll(scroller,{target:{scrollTop:50}});
 view.rerender(timeline(false));
 expect(mocks.scrollToEnd).toHaveBeenCalledTimes(1);
 expect(scroller.scrollTop).toBe(50);
});

it('does not treat a hidden tab as a reader returning to the latest message',()=>{
 const pinned=createRef<boolean>();pinned.current=true;
 const timeline=(hidden:boolean)=><MessageTimeline label="Messages" items={[]} page={null} loading={null} latestVersion={1} hidden={hidden} load={()=>{}} pinned={pinned} render={()=>null}/>;
 const view=render(timeline(false));
 const scroller=screen.getByLabelText('Messages');
 let height=100,total=400;
 Object.defineProperties(scroller,{scrollHeight:{get:()=>total},clientHeight:{get:()=>height}});
 fireEvent.scroll(scroller,{target:{scrollTop:50}});
 view.rerender(timeline(true));
 height=0;total=0;
 fireEvent.scroll(scroller,{target:{scrollTop:0}});
 expect(pinned.current).toBe(false);
 height=100;total=400;
 view.rerender(timeline(false));
 expect(screen.getByRole('button',{name:'Jump to latest'})).toBeTruthy();
 expect(mocks.scrollToEnd).toHaveBeenCalledTimes(1);
 expect(mocks.scrollToOffset).toHaveBeenCalledWith(50);
});

it.each([true,false])('keeps resize anchored only for readers at the end: %s',atEnd=>{
 let resize!:()=>void;
 vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){resize=callback;}observe(){}disconnect(){}});
 const pinned=createRef<boolean>();pinned.current=true;
 render(<MessageTimeline label="Messages" items={[]} page={null} loading={null} latestVersion={0} load={()=>{}} pinned={pinned} render={()=>null}/>);
 const scroller=screen.getByLabelText('Messages');
 let height=100;
 Object.defineProperties(scroller,{scrollHeight:{value:400},clientHeight:{get:()=>height}});
 fireEvent.scroll(scroller,{target:{scrollTop:atEnd?300:50}});
 height=60;resize();
 expect(scroller.scrollTop).toBe(atEnd?400:50);
});

it('scrolls an introductory section with the messages and still reveals the right message',()=>{
 const pinned=createRef<boolean>(),handle=createRef<TimelineHandle|null>();pinned.current=true;
 const event:ChatEvent={type:'message.created',channel_id:'channel',thread_id:'thread',sequence:'1',occurred_at:'2026-11-04T09:00:00Z',payload:{id:'one',channel_id:'channel',thread_id:'thread',text:'Live message',created_at:'2026-11-04T09:00:00Z',client_message_id:null,author:{kind:'human',id:'user',name:'Kai'}}};
 render(<MessageTimeline label="Messages" items={[event]} header={<section aria-label="Selected messages">Saved context</section>} page={null} loading={null} latestVersion={0} load={()=>{}} pinned={pinned} handle={handle} render={(_,index)=><p>Message {index+1}</p>}/>);
 const context=screen.getByRole('region',{name:'Selected messages'}),message=screen.getByText('Message 1');
 expect(screen.getByLabelText('Messages').contains(context)).toBe(true);
 expect(context.compareDocumentPosition(message)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 handle.current!.reveal('one');
 expect(mocks.scrollToIndex).toHaveBeenCalledWith(1,{align:'center'});
});

it.each([false,true])('moves to the linked message before focusing it, respecting reduced motion=%s',async reduced=>{
 mocks.reduced=reduced;
 const pinned=createRef<boolean>(),handle=createRef<TimelineHandle|null>();
 const rows=['first','middle','last'].map(id=>({id,messageId:id}));
 render(<MessageTimeline label="Messages" items={rows} page={null} loading={null} latestVersion={0} load={()=>{}} pinned={pinned} handle={handle} render={row=><p id={'chat-message-'+row.id} tabIndex={-1}>{row.id}</p>}/>);
 const scroller=screen.getByLabelText('Messages'),offsets:number[]=[];
 Object.defineProperties(scroller,{clientHeight:{value:100},scrollTop:{get:()=>offsets.at(-1)??0,set:(y:number)=>offsets.push(y)}});
 handle.current!.reveal('last');
 await waitFor(()=>expect(document.activeElement).toBe(screen.getByText('last')));
 expect(offsets.some(y=>y>0 && y<200)).toBe(!reduced);
 expect(mocks.scrollToIndex).toHaveBeenCalledWith(2,{align:'center'});
});

it('keeps the jump control mounted for its exit transition but removes it from interaction at the latest message',async()=>{
 const load=vi.fn(),pinned=createRef<boolean>();pinned.current=true;
 const timeline=(version:number)=><MessageTimeline label="Messages" items={[]} page={null} loading={null} latestVersion={version} load={load} pinned={pinned} render={()=>null}/>;
 render(timeline(0));
 expect(screen.queryByRole('button',{name:'Jump to latest'})).toBeNull();
 const scroller=screen.getByLabelText('Messages');
 Object.defineProperties(scroller,{scrollHeight:{value:400},clientHeight:{value:100}});
 fireEvent.scroll(scroller,{target:{scrollTop:50}});
 const jump=screen.getByRole('button',{name:'Jump to latest'});
 await userEvent.click(jump);expect(mocks.scrollToEnd).toHaveBeenCalledWith({behavior:'smooth'});
 fireEvent.scroll(scroller,{target:{scrollTop:300}});
 expect(jump.isConnected).toBe(true);
 expect(screen.queryByRole('button',{name:'Jump to latest'})).toBeNull();
 expect(jump.closest('[inert]')).not.toBeNull();
});

it.each([false,true])('scrolls the loaded latest page without refetching: reduced motion=%s',async reduced=>{
 mocks.reduced=reduced;
 const load=vi.fn(),pinned=createRef<boolean>();pinned.current=false;
 render(<MessageTimeline label="Messages" items={[]} page={null} loading={null} latestVersion={0} load={load} pinned={pinned} render={()=>null}/>);
 const scroller=screen.getByLabelText('Messages');
 Object.defineProperties(scroller,{scrollHeight:{value:400},clientHeight:{value:100}});
 fireEvent.scroll(scroller,{target:{scrollTop:50}});
 await userEvent.click(screen.getByRole('button',{name:'Jump to latest'}));
 expect(mocks.scrollToEnd).toHaveBeenCalledWith({behavior:reduced?'auto':'smooth'});
 expect(load).not.toHaveBeenCalled();
});

const page=(hasNewer:boolean):MessagePage=>({messages:[],older_cursor:null,newer_cursor:null,has_older:false,has_newer:hasNewer,event_cursor:'0'});
it('fetches missing latest history before smoothly scrolling, then restores instant scrolling for other updates',async()=>{
 const load=vi.fn().mockResolvedValue(page(false)),pinned=createRef<boolean>();pinned.current=false;
 const timeline=(version:number,newer:boolean)=><MessageTimeline label="Messages" items={[]} page={page(newer)} loading={null} latestVersion={version} load={load} pinned={pinned} render={()=>null}/>;
 const view=render(timeline(0,true));
 await userEvent.click(screen.getByRole('button',{name:'Jump to latest'}));
 expect(load).toHaveBeenCalledWith('latest');expect(mocks.scrollToEnd).not.toHaveBeenCalled();
 view.rerender(timeline(1,false));expect(mocks.scrollToEnd).toHaveBeenLastCalledWith({behavior:'smooth'});
 view.rerender(timeline(2,false));expect(mocks.scrollToEnd).toHaveBeenLastCalledWith({behavior:'auto'});
});

it('does not carry smooth scrolling into another update after a failed latest-page load',async()=>{
 const load=vi.fn().mockResolvedValue(undefined),pinned=createRef<boolean>();pinned.current=false;
 const timeline=(version:number)=><MessageTimeline label="Messages" items={[]} page={page(true)} loading={null} latestVersion={version} load={load} pinned={pinned} render={()=>null}/>;
 const view=render(timeline(0));
 await userEvent.click(screen.getByRole('button',{name:'Jump to latest'}));
 view.rerender(timeline(1));expect(mocks.scrollToEnd).toHaveBeenLastCalledWith({behavior:'auto'});
});
