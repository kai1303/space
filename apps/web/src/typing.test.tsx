import {act,cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {TypingIndicator,useTypingPublisher} from './typing.js';
const mocks=vi.hoisted(()=>({handlers:new Map<string,Set<(value:any)=>void>>(),sent:[] as any[]}));
vi.mock('./socket-session.js',()=>({acquireRealtime:()=>({on:(name:string,fn:(value:any)=>void)=>{const set=mocks.handlers.get(name)??new Set();set.add(fn);mocks.handlers.set(name,set);return()=>set.delete(fn);},release:()=>{}})}));
const event=(id:string,name:string,source=id,thread:string|null=null,active=true)=>({channel_id:'channel',thread_id:thread,user:{id,name},source_id:source,active,expires_at:Date.now()+6000});
const typingText=()=>screen.getAllByRole('status').map(node=>node.textContent);
function receive(value:any){act(()=>{for(const fn of mocks.handlers.get('chat.typing')??[])fn(value);});}
afterEach(()=>{cleanup();mocks.handlers.clear();mocks.sent=[];vi.useRealTimers();});
it('shows other people once across tabs, separates channels and threads, and expires silently',()=>{
 vi.useFakeTimers();render(<><TypingIndicator channel="channel" viewerId="me"/><TypingIndicator channel="channel" thread="thread" viewerId="me"/></>);
 receive(event('me','Myself'));receive({...event('outside','Outsider'),channel_id:'other'});expect(screen.queryByText(/typing/)).toBeNull();
 receive(event('kai','Kai','tab1'));receive(event('kai','Kai','tab2'));expect(typingText()).toContain('Kai is typing');
 receive(event('alex','Alex'));expect(typingText()).toContain('Kai and Alex are typing');
 receive(event('sam','Sam','sam','thread'));expect(typingText()).toContain('Sam is typing');
 receive(event('kai','Kai','tab1',null,false));expect(typingText()).toContain('Kai and Alex are typing');
 act(()=>vi.advanceTimersByTime(6001));expect(screen.queryByText(/typing/)).toBeNull();
});
it('clears typing on disconnect and revocation',()=>{
 render(<TypingIndicator channel="channel" viewerId="me"/>);receive(event('kai','Kai'));
 act(()=>{for(const fn of mocks.handlers.get('disconnect')??[])fn(undefined);});expect(screen.queryByText(/typing/)).toBeNull();
 receive(event('kai','Kai'));act(()=>{for(const fn of mocks.handlers.get('channel.revoked')??[])fn({channel_id:'channel'});});expect(screen.queryByText(/typing/)).toBeNull();
});
it('publishes activity without draft content, throttles updates, and stops on idle, blur and unmount',async()=>{
 vi.useFakeTimers();let publisher!:ReturnType<typeof useTypingPublisher>;
 const socket:any={connected:true,timeout:()=>({emitWithAck:async(name:string,data:object)=>{mocks.sent.push({name,data});return{data};}})};
 function Composer(){publisher=useTypingPublisher(socket,'channel','thread');return null;}
 const view=render(<Composer/>);
 await act(async()=>{publisher.change({ops:[{insert:'Private unsent draft'}]});publisher.change({ops:[{insert:'Private unsent draft continued'}]});});
 expect(mocks.sent).toEqual([{name:'typing.change',data:{channel_id:'channel',thread_id:'thread',active:true}}]);
 act(()=>vi.advanceTimersByTime(2000));await act(async()=>publisher.change({ops:[{insert:'Still writing'}]}));expect(mocks.sent).toHaveLength(2);
 await act(async()=>vi.advanceTimersByTime(3000));expect(mocks.sent.at(-1).data.active).toBe(false);
 await act(async()=>publisher.change({ops:[{insert:'Again'}]}));await act(async()=>window.dispatchEvent(new Event('blur')));expect(mocks.sent.at(-1).data.active).toBe(false);
 await act(async()=>publisher.change({ops:[{insert:'Again'}]}));await act(async()=>view.unmount());expect(mocks.sent.at(-1).data.active).toBe(false);
});

it('uses plain typing text with bold names and a several-people summary',()=>{
 const view=render(<TypingIndicator channel="channel" viewerId="me"/>);
 receive(event('kai','Kai'));
 expect(screen.getByText('Kai').tagName).toBe('STRONG');
 expect(screen.getByRole('status').textContent).toBe('Kai is typing');
 expect(view.container.querySelector('.chat-typing-dots')).toBeNull();
 receive(event('alex','Alex'));
 expect(screen.getByText('Alex').tagName).toBe('STRONG');
 expect(screen.getByRole('status').textContent).toBe('Kai and Alex are typing');
 receive(event('sam','Sam'));
 expect(screen.getByRole('status').textContent).toBe('Several people are typing');
});
