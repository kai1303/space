import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidekick } from './Sidekick.js';
import { StrictMode } from 'react';
vi.mock('./AgentSessions.js',()=>({AgentSessions:(props:any)=><div>Private conversation {props.initialSessionId}</div>}));
const agent={id:'mine',owner_id:'me',enabled:true,name:'My Codex',capabilities:{skills:['codex.run'],persistent_sessions:true}};
const source={channel_id:'channel',message_ids:['one','two']};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('hands selected message IDs to an owned agent and opens the private session without executing a turn',async()=>{
 const fetch=vi.fn(async(path:string,init?:RequestInit)=>({ok:true,json:async()=>path.includes('sidekick-agents')?[agent,{...agent,id:'other',owner_id:'other'}]:init?.method==='POST'?{id:'private',channel_id:'self',origin_thread_id:'private-thread'}:{items:[],next_cursor:null}}));
 vi.stubGlobal('fetch',fetch);render(<StrictMode><Sidekick workspace="workspace" viewerId="me" source={source} onClose={()=>{}}/></StrictMode>);
 await screen.findByText('Private conversation private');
 const call=fetch.mock.calls.find(([,init])=>init?.method==='POST')!;
 expect(JSON.parse(String(call[1]?.body))).toMatchObject({installation_id:'mine',source});
 expect(fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(fetch.mock.calls.some(([path])=>path.endsWith('/messages'))).toBe(false);
});
it('preserves retry identity on an uncertain create and offers an actionable empty state',async()=>{
 let attempts=0;
 const fetch=vi.fn(async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){attempts++;return{ok:false,status:503,json:async()=>({error:'temporarily_unavailable'})};}return{ok:true,json:async()=>path.includes('sidekick-agents')?[agent]:{items:[],next_cursor:null}};});
 vi.stubGlobal('fetch',fetch);render(<Sidekick workspace="workspace" viewerId="me" source={source} onClose={()=>{}}/>);
 await screen.findByRole('alert');
 expect(attempts).toBe(1);
 await userEvent.click(screen.getByRole('button',{name:'Start private discussion'}));
 await waitFor(()=>expect(attempts).toBe(2));
 const calls=fetch.mock.calls.filter(([,init])=>init?.method==='POST');
 expect(calls[0]![1]?.body).toBe(calls[1]![1]?.body);
});
it('lets the user choose when multiple connected agents are available',async()=>{
 const fetch=vi.fn(async(path:string,init?:RequestInit)=>({ok:true,json:async()=>path.includes('sidekick-agents')?[agent,{...agent,id:'second',name:'Second agent'}]:init?.method==='POST'?{id:'private',channel_id:'self',origin_thread_id:'private-thread'}:{items:[],next_cursor:null}}));
 vi.stubGlobal('fetch',fetch);render(<Sidekick workspace="workspace" viewerId="me" source={source} onClose={()=>{}}/>);
 await screen.findByRole('combobox',{name:'Connected agent'});
 expect(fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
 await userEvent.click(screen.getByRole('combobox',{name:'Connected agent'}));
 await userEvent.click(await screen.findByRole('option',{name:'Second agent'}));
 await userEvent.click(screen.getByRole('button',{name:'Start private discussion'}));
 await screen.findByText('Private conversation private');
 expect(JSON.parse(String(fetch.mock.calls.find(([,init])=>init?.method==='POST')![1]?.body))).toMatchObject({installation_id:'second',source});
});
it('does not offer another user’s agent or an unsupported connector',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>({ok:true,json:async()=>path.includes('sidekick-agents')?[{...agent,owner_id:'other'},{...agent,capabilities:{skills:['run']}}]:{items:[],next_cursor:null}})));
 render(<Sidekick workspace="workspace" viewerId="me" source={source} onClose={()=>{}}/>);
 await screen.findByText(/Connect a session-capable agent/);
 expect(screen.getByRole('button',{name:'Start private discussion'}).hasAttribute('disabled')).toBe(true);
});
it('opens only the latest selection when an earlier session creation completes late',async()=>{
 let finishFirst!:(value:unknown)=>void;
 const fetch=vi.fn(async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));
   if(body.source.message_ids[0]==='one')return new Promise(resolve=>{finishFirst=resolve;});
   return {ok:true,json:async()=>({id:'latest',channel_id:'self',origin_thread_id:'latest-thread'})};
  }
  return {ok:true,json:async()=>path.includes('sidekick-agents')?[agent]:{items:[],next_cursor:null}};
 });
 vi.stubGlobal('fetch',fetch);
 const view=render(<Sidekick workspace="workspace" viewerId="me" source={source} onClose={()=>{}}/>);
 await waitFor(()=>expect(finishFirst).toBeTypeOf('function'));
 const next={channel_id:'channel',message_ids:['three']};
 view.rerender(<Sidekick workspace="workspace" viewerId="me" source={next} onClose={()=>{}}/>);
 await screen.findByText('Private conversation latest');
 await act(async()=>{finishFirst({ok:true,json:async()=>({id:'old',channel_id:'self',origin_thread_id:'old-thread'})});});
 expect(screen.queryByText('Private conversation old')).toBeNull();
 expect(screen.getByText('Private conversation latest')).toBeTruthy();
 const calls=fetch.mock.calls.filter(([,init])=>init?.method==='POST');
 expect(calls).toHaveLength(2);
 expect(JSON.parse(String(calls[1]![1]?.body))).toMatchObject({source:next});
});
