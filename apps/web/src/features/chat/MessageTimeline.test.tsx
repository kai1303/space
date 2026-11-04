import {createRef} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {MessageTimeline} from './MessageTimeline.js';
import type {MessagePage} from '@space/contracts';

const mocks=vi.hoisted(()=>({scrollToEnd:vi.fn(),reduced:false}));
vi.mock('motion/react',async original=>({...await original<typeof import('motion/react')>(),useReducedMotion:()=>mocks.reduced}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:()=>({getVirtualItems:()=>[],getTotalSize:()=>0,scrollToEnd:mocks.scrollToEnd,scrollToIndex:()=>{},measureElement:()=>{}})}));
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.reduced=false;});

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
