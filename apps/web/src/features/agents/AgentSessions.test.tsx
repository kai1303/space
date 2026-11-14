import {documentText,type RichDocument} from '@space/ui/rich-text';
import type {MessageAttempt} from '../composer/message-sender.js';
import {useState} from 'react';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {AgentSessions} from './AgentSessions.js';
const mocks=vi.hoisted(()=>({refresh:undefined as undefined|(()=>unknown),revoke:undefined as undefined|(()=>void)}));
vi.mock('../../shared/realtime/live-updates.js',()=>{
 const readers=new Map<string,Set<()=>unknown>>();
 return {subscribeUpdates:(scope:string,id:string,refresh:()=>unknown,revoke:()=>void)=>{
  if(scope==='thread'){mocks.refresh=refresh;mocks.revoke=revoke;}
  const key=`${scope}:${id}`,group=readers.get(key)??new Set();readers.set(key,group);group.add(refresh);void refresh();
  return()=>{group.delete(refresh);};
 },invalidateUpdates:async(scope:string,id:string)=>{await Promise.all([...readers.get(`${scope}:${id}`)??[]].map(read=>read()));}};
});
// jsdom has no layout; mount fixture rows while testing the shared timeline flow.
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:(options:any)=>({getTotalSize:()=>options.count*100+88,getVirtualItems:()=>Array.from({length:options.count},(_,index)=>({index,key:options.getItemKey(index),start:index*100+44})),measureElement:()=>{},scrollToEnd:()=>{},scrollToIndex:()=>{},isAtEnd:()=>true})}));
const session=(id:string,title:string)=>({id,title,workspace_id:'workspace',installation_id:'agent',origin_thread_id:'thread',managed:true,state:'active',agent_name:'Codex',supports_steering:true,owner_id:'user',created_by:'user',created_at:'2026-11-03T00:00:00Z',skill:'codex.run',turn_count:1});
const turn=(text:string)=>({task:{id:text,goal:text,workspace_id:'workspace',thread_id:'thread',installation_id:'agent',requester_id:'user',session_id:'one',skill:'codex.run',status:'completed',result:`Result: ${text}`,revision:1},requester_name:'Kai',detail:`Result: ${text}`,response:{messages:[{id:'answer',text:`Result: ${text}`,status:'complete'}],tools:[],components:[],outputs:{files:[{path:'result.txt',content:text}],changes:[]}}});
function setup(){
 let sessions=[session('one','Research'),session('two','Implementation')];
 const fetch=vi.fn(async(path:string,init?:RequestInit)=>({ok:true,json:async()=>{
  if(path.endsWith('/models'))return [{id:'provider-default',label:'Connector default',efforts:['low','medium'],defaultEffort:'medium',isDefault:true},{id:'sdk-model-42',label:'Model 42',efforts:['low','medium','high','ultra'],defaultEffort:'low'}];
  if(path.endsWith('/project-picker'))return {selection:{name:'Project A',project_token:'folder-selection'}};
  if(path==='/v1/channels/channel/navigator')return {candidates:[{project_picker:true,installation_id:'agent',skill:'codex.run',name:'Codex',persistent_sessions:true}]};
  if(path==='/v1/channels/channel/agents')return [];
  if(path==='/v1/threads/thread/agent-sessions'){
   if(init?.method==='POST'){const body=JSON.parse(String(init.body));const created=session(body.client_session_id,body.title);sessions=[...sessions,created];return created;}
   return {items:sessions,next_cursor:null};
  }
  if(path==='/v1/agent-sessions/one')return {session:sessions[0],turns:[turn('Research prompt')],next_cursor:null};
  if(path==='/v1/agent-sessions/two')return {session:sessions[1],turns:[turn('Implementation prompt')],next_cursor:null};
  if(path.endsWith('/messages'))return {...turn('Follow up').task,status:'queued'};
  const found=sessions.find(s=>path===`/v1/agent-sessions/${s.id}`);
  if(found)return {session:found,turns:[],next_cursor:null};
  return {};
 }}));vi.stubGlobal('fetch',fetch);return fetch;
}
function SessionViews({onAccessLost=()=>{}}:{onAccessLost?:()=>void}){
 const [selected,setSelected]=useState(''),[picking,setPicking]=useState(true);
 const open=(id:string)=>{setSelected(id);setPicking(false);};
 return <><div hidden={!picking}><AgentSessions thread="thread" channel="channel" viewerId="user" onAccessLost={onAccessLost} onOpenSession={open}/></div>{selected&&<div hidden={picking}><button onClick={()=>setPicking(true)}>Back to thread</button><AgentSessions thread="thread" channel="channel" viewerId="user" onAccessLost={onAccessLost} initialSessionId={selected}/></div>}</>;
}
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};});
beforeAll(()=>Object.defineProperties(Range.prototype,{getBoundingClientRect:{configurable:true,value:()=>new DOMRect()},getClientRects:{configurable:true,value:()=>[]}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
afterAll(()=>{Reflect.deleteProperty(Range.prototype,'getBoundingClientRect');Reflect.deleteProperty(Range.prototype,'getClientRects');});
it('uses the conversation skeleton through initial message loading without replacing loaded messages on refresh',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 let finishRead!:(value:any)=>void;
 fetch.mockImplementation(async(path,init)=>path==='/v1/agent-sessions/one'?new Promise(resolve=>{finishRead=resolve;}):original(path,init));
 const view=render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 expect(screen.getByRole('status',{name:'Loading messages'})).toBeTruthy();
 expect(view.container.querySelector('.chat-conversation-skeleton')).toBeTruthy();
 expect(screen.queryByText('This session is unavailable.')).toBeNull();
 const response={ok:true,json:async()=>({session:session('one','Research'),turns:[turn('Research prompt')],next_cursor:null})};
 await act(async()=>{finishRead(response);});
 await screen.findByText('Research prompt');
 expect(fetch.mock.calls.filter(([path])=>path==='/v1/agent-sessions/one')).toHaveLength(1);
 expect(screen.queryByRole('status',{name:'Loading messages'})).toBeNull();
 act(()=>{void mocks.refresh?.();});
 expect(screen.getByText('Research prompt')).toBeTruthy();
 expect(view.container.querySelector('.chat-conversation-skeleton')).toBeNull();
});
it('lets users retry an initial session load failure',async()=>{
 const fetch=setup();fetch.mockRejectedValueOnce(new Error('Network unavailable'));
 const view=render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 await screen.findByText(/Network unavailable/);
 expect(view.container.querySelector('.chat-conversation-skeleton')).toBeNull();
 expect(screen.queryByText('This session is unavailable.')).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'Retry loading messages'}));
 await screen.findByText('Research prompt');
 expect(screen.queryByRole('alert')).toBeNull();
});
it('keeps the conversation draft beside published files and returns focus on Escape',async()=>{
 setup();render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.type(editor,'Keep my draft');
 const trigger=screen.getByRole('button',{name:/Artifacts 1/});
 await userEvent.click(trigger);
 expect(screen.getByRole('button',{name:'result.txt',exact:true})).toBeTruthy();
 expect(screen.getByRole('tab',{name:'Files',selected:true})).toBe(document.activeElement);
 expect(screen.getByRole('textbox',{name:'Message agent session'})).toBe(editor);
 await userEvent.keyboard('{Escape}');
 expect(screen.queryByRole('tablist',{name:'Artifact views'})).toBeNull();
 expect(document.activeElement).toBe(trigger);
 expect(editor.textContent).toContain('Keep my draft');
});
it('opens sessions from their thread and keeps the conversation and files in the same session view',async()=>{
 setup();render(<SessionViews/>);
 await userEvent.click(await screen.findByRole('button',{name:'Research',exact:true}));
 await screen.findByText('Research prompt');
 await userEvent.click(screen.getByRole('button',{name:/Artifacts 1/}));
 expect(await screen.findByRole('button',{name:'result.txt',exact:true})).toBeTruthy();
 expect(screen.queryByRole('region',{name:'Agent workspace'})).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'Back to thread'}));
 await userEvent.click(screen.getByRole('button',{name:'Implementation',exact:true}));
 await screen.findByText('Implementation prompt');
 expect(screen.queryByText('Research prompt')).toBeNull();
});
it('creates another session and sends only through its own composer with a retry key',async()=>{
 const fetch=setup();render(<SessionViews/>);
 await userEvent.click(await screen.findByRole('button',{name:'New agent session'}));
 await userEvent.type(screen.getByRole('textbox',{name:'Session name'}),'Design review');
 await userEvent.click(screen.getByRole('button',{name:'Choose project folder…'}));
 await screen.findByRole('button',{name:'Project A'});
 await userEvent.click(screen.getByRole('button',{name:'Start session',exact:true}));
 await screen.findByText(/Codex was invited to this agent session/);
 const posted = fetch.mock.calls.find(([url,init])=>url.endsWith('/agent-sessions') && init?.method==='POST');
 const picked = fetch.mock.calls.find(([url])=>url.endsWith('/project-picker'));
 expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({client_session_id:JSON.parse(String(picked?.[1]?.body)).session_id, project_token:'folder-selection'});
 const composer=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.type(composer,'Follow up');await userEvent.keyboard('{Enter}');
 await waitFor(()=>expect(fetch.mock.calls.some(([path,init])=>path.endsWith('/messages')&&init?.headers&&new Headers(init.headers).get('idempotency-key'))).toBe(true));
 expect(fetch.mock.calls.some(([path])=>path.includes('/channels/channel/messages'))).toBe(false);
});
it('clears the entire session view immediately when thread access is revoked',async()=>{
 setup();const lost=vi.fn();render(<SessionViews onAccessLost={lost}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Research',exact:true}));await screen.findByText('Research prompt');
 act(()=>mocks.revoke?.());
 expect(screen.queryByText('Research prompt')).toBeNull();expect(lost).toHaveBeenCalledOnce();
});
it('keeps each session draft when switching sessions',async()=>{
 setup();render(<SessionViews/>);
 await userEvent.click(await screen.findByRole('button',{name:'Research',exact:true}));
 await userEvent.type(await screen.findByRole('textbox',{name:'Message agent session'}),'Research draft');
 await userEvent.click(screen.getByRole('button',{name:'Back to thread'}));
 await userEvent.click(screen.getByRole('button',{name:'Implementation',exact:true}));
 expect((await screen.findByRole('textbox',{name:'Message agent session'})).textContent?.trim()).toBe('');
 await userEvent.type(screen.getByRole('textbox',{name:'Message agent session'}),'Implementation draft');
 await userEvent.click(screen.getByRole('button',{name:'Back to thread'}));
 await userEvent.click(screen.getByRole('button',{name:'Research',exact:true}));
 expect((await screen.findByRole('textbox',{name:'Message agent session'})).textContent).toContain('Research draft');
});
it('shows session-level saved outputs even when their turn is outside the loaded conversation page',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 fetch.mockImplementation(async(path,init)=>path==='/v1/agent-sessions/one'?{ok:true,json:async()=>({session:session('one','Research'),turns:[],next_cursor:'older-turn',outputs:{files:[{path:'earlier-output.txt',content:'Saved earlier'}],changes:[]}})}:original(path,init));
 render(<SessionViews/>);
 await userEvent.click(await screen.findByRole('button',{name:'Research',exact:true}));
 await screen.findByRole('button',{name:'Load older history'});
 await userEvent.click(screen.getByRole('button',{name:/Artifacts 1/}));
 expect(await screen.findByRole('button',{name:'earlier-output.txt',exact:true})).toBeTruthy();
});
it('retains the draft and retry identity after an uncertain send',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;let sends=0;
 fetch.mockImplementation(async(path,init)=>{if(path.endsWith('/messages')&&++sends===1)throw new Error('Lost acknowledgment');return original(path,init);});
 render(<SessionViews/>);
 await userEvent.click(await screen.findByRole('button',{name:'Research',exact:true}));
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});await userEvent.type(editor,'Please continue');await userEvent.keyboard('{Enter}');
 await screen.findByRole('alert');expect(editor.textContent).toContain('Please continue');
 await userEvent.click(screen.getByRole('button',{name:'Send now'}));
 await waitFor(()=>expect(editor.textContent?.trim()).toBe(''));
 const attempts=fetch.mock.calls.filter(([path])=>path.endsWith('/messages'));
 expect(attempts).toHaveLength(2);
 expect(new Headers(attempts[0]![1]?.headers).get('idempotency-key')).toBe(new Headers(attempts[1]![1]?.headers).get('idempotency-key'));
});
it('clears cached conversation when a send discovers lost access',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;const lost=vi.fn();
 fetch.mockImplementation(async(path,init)=>path.endsWith('/messages')?{ok:false,status:404,json:async()=>({error:'not_found'})}:original(path,init));
 render(<SessionViews onAccessLost={lost}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Research',exact:true}));
 await userEvent.type(await screen.findByRole('textbox',{name:'Message agent session'}),'Check access');await userEvent.keyboard('{Enter}');
 await waitFor(()=>expect(lost).toHaveBeenCalledOnce());expect(screen.queryByRole('log',{name:'Session conversation'})).toBeNull();
});
it('renders an interrupted turn without a reply as a Space notice',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 const sample=turn('Look up the runbook');
 fetch.mockImplementation(async(path,init)=>path==='/v1/agent-sessions/one'?{ok:true,json:async()=>({
  session:session('one','Research'),turns:[{...sample,task:{...sample.task,status:'failed',result:null},response:null,detail:'local_execution_interrupted'}],next_cursor:null,
 })}:original(path,init));
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 const notice=(await screen.findByText(/· Turn interrupted/)).closest('[role="status"]');
 expect(notice?.textContent).toBe('Space · Turn interrupted');
 expect(within(screen.getByRole('log',{name:'Session conversation'})).getAllByRole('article')).toHaveLength(1);
 expect(screen.queryByText('local_execution_interrupted')).toBeNull();
});
it('stops work without losing a prepared draft and makes ended sessions read-only',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;let stopped=false,ended=false;
 fetch.mockImplementation(async(path,init)=>{
  if(path==='/v1/agent-sessions/one/stop'){stopped=true;return {ok:true,json:async()=>session('one','Research')};}
  if(path==='/v1/agent-sessions/one')return {ok:true,json:async()=>({session:{...session('one','Research'),state:ended?'ended':'active'},turns:[{...turn('Research prompt'),detail:stopped?'session_stopped':turn('Research prompt').detail,task:{...turn('Research prompt').task,status:stopped?'failed':'running'}}],next_cursor:null})};
  return original(path,init);
 });
 render(<SessionViews/>);
 await userEvent.click(await screen.findByRole('button',{name:'Research',exact:true}));
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});await userEvent.type(editor,'A prepared follow-up');
 await userEvent.click(screen.getByRole('button',{name:'Stop',exact:true}));
 const notice=await screen.findByText(/· Turn stopped/);expect(notice.closest('article')).toBeNull();expect(screen.getByText('Result: Research prompt')).toBeTruthy();expect(editor.textContent).toContain('A prepared follow-up');
 expect(screen.queryByRole('button',{name:'End session',exact:true})).toBeNull();
 ended=true;await act(async()=>{await mocks.refresh?.();});
 await screen.findByText('Session ended');expect(screen.getByRole('button',{name:'Reopen session'})).toBeTruthy();expect(screen.queryByRole('textbox',{name:'Message agent session'})).toBeNull();
});

it('shows one waiting indicator for Kiro and adds the reply when it arrives',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 const answered=turn('Check my session');
 const waiting={...answered,task:{...answered.task,status:'queued',result:null},detail:'',response:null};
 const thinking={...waiting,task:{...waiting.task,status:'running'},detail:'Kiro session is ready.',response:{activity:'thinking',messages:[],tools:[],components:[]}};
 let current:typeof waiting | typeof thinking | typeof answered=waiting;
 fetch.mockImplementation(async(path,init)=>path==='/v1/agent-sessions/one'?{ok:true,json:async()=>({
  session:{...session('one','Research'),agent_name:'Local Kiro'},turns:[current],next_cursor:null,
 })}:original(path,init));
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 const log=await screen.findByRole('log',{name:'Session conversation'});
 await within(log).findByText('Check my session');
 expect(screen.queryAllByText(/queued/i)).toHaveLength(0);
 expect(within(log).getAllByRole('article')).toHaveLength(1);
 expect(screen.getByText('Waiting for',{exact:false}).textContent).toContain('Waiting for Local Kiro');
 const composer=within(screen.getByRole('textbox',{name:'Message agent session'}).closest('.chat-compose')!);
 expect(composer.getByRole('button',{name:'Stop'})).toBeTruthy();
 expect(composer.queryByRole('button',{name:'Send now'})).toBeNull();
 expect(screen.queryByText(/You can draft your next message/)).toBeNull();
 current=thinking;await act(async()=>{await mocks.refresh?.();});
 await screen.findByText('is thinking…');
 expect(within(log).getAllByRole('article')).toHaveLength(1);
 current=answered;await act(async()=>{await mocks.refresh?.();});
 expect(composer.queryByRole('button',{name:'Stop'})).toBeNull();
 expect(composer.getByRole('button',{name:'Send now'})).toBeTruthy();
 const reply = log.querySelector('.sp-agent-markdown')!;
 expect(reply.textContent).not.toBe(answered.task.result);
 await waitFor(()=>expect(reply.querySelector('.sp-agent-word')).toBeTruthy());
 await waitFor(()=>expect(reply.textContent).toBe(answered.task.result));
 expect(within(log).getAllByRole('article')).toHaveLength(2);
 expect(screen.queryByText(/Waiting for Local Kiro/)).toBeNull();
});
it('queues Enter during a turn and targets the active execution when steering is selected',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 const queued={id:'q',text:'My next instruction',kind:'queue',actor_id:'user',state:'pending'};
 let items:object[]=[],steering:object[]=[];
 fetch.mockImplementation(async(path,init)=>{
  if(path==='/v1/agent-sessions/one')return {ok:true,json:async()=>({session:session('one','Research'),inputs:items,turns:[{...turn('Research prompt'),steering,task:{...turn('Research prompt').task,status:'running',active_execution_id:'run'}}],next_cursor:null})};
  if(path.endsWith('/queue')){items=[queued];return {ok:true,json:async()=>({id:'q',state:'pending'})};}
  if(path.endsWith('/steer')){
   items=[];steering=[{...queued,id:'s',actor_name:'Kai',kind:'steer',state:'sent',created_at:'2026-11-03T10:25:00Z'}];
   return {ok:true,json:async()=>({id:'s',state:'sent'})};
  }
  return original(path,init);
 });
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.type(editor,'My next instruction');
 await userEvent.keyboard('{Control>}{Enter}{/Control}');
 const list=await screen.findByRole('list',{name:'Queued messages'});
 await userEvent.click(within(list).getByRole('button',{name:'Steer'}));
 await waitFor(()=>expect(fetch.mock.calls.some(([path,init])=>path.endsWith('/steer') && JSON.parse(String(init?.body)).execution_id==='run')).toBe(true));
 const log=screen.getByRole('log',{name:'Session conversation'});
 const sent=await within(log).findByText('My next instruction');
 expect(sent.closest('article')?.textContent).toContain('Kai');
 expect(within(log).queryByText('Steering accepted')).toBeNull();
 expect(fetch.mock.calls.filter(([path])=>path.endsWith('/messages'))).toHaveLength(0);
});
it('keeps an unsent steering draft tied to its original turn when the turn finishes',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 let status='running';
 fetch.mockImplementation(async(path,init)=>path==='/v1/agent-sessions/one'?{ok:true,json:async()=>({
  session:session('one','Research'),turns:[{...turn('Research prompt'),task:{...turn('Research prompt').task,status,active_execution_id:'run'}}],next_cursor:null
 })}:original(path,init));
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.type(editor,'Wait for my review');
 status='completed';await act(async()=>{await mocks.refresh?.();});
 await userEvent.type(editor,'{Enter}');
 expect(fetch.mock.calls.filter(([path])=>/\/(messages|steer|queue)$/.test(path))).toHaveLength(0);
 await userEvent.click(screen.getByRole('button',{name:'Use draft as follow-up'}));
 expect(editor.textContent).toContain('Wait for my review');
 expect((screen.getByRole('button',{name:'Send now'}) as HTMLButtonElement).disabled).toBe(false);
});
it('keeps sending blocked after acknowledgment until the accepted turn is observed despite an earlier refresh',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 let finishSend!:(value:any)=>void,finishRead!:(value:any)=>void,holdReads=false;
 fetch.mockImplementation(async(path,init)=>{
  if(path.endsWith('/messages'))return new Promise(resolve=>{finishSend=resolve;});
  if(path==='/v1/agent-sessions/one'&&holdReads)return new Promise(resolve=>{finishRead=resolve;});
  return original(path,init);
 });
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.type(editor,'First accepted turn');await userEvent.keyboard('{Enter}');
 await act(async()=>{await mocks.refresh?.();});
 const accepted={...turn('Accepted task').task,status:'queued'};
 await act(async()=>{holdReads=true;finishSend({ok:true,json:async()=>accepted});});
 await waitFor(()=>expect(editor.textContent?.trim()).toBe(''));
 await userEvent.type(editor,'The next draft');await userEvent.keyboard('{Enter}');
 expect(fetch.mock.calls.filter(([path])=>path.endsWith('/messages'))).toHaveLength(1);
 expect(editor.textContent).toContain('The next draft');
 await act(async()=>{finishRead({ok:true,json:async()=>({session:session('one','Research'),turns:[turn('Research prompt'),{...turn('Accepted task'),task:accepted}],next_cursor:null})});});
 expect((screen.getByRole('button',{name:'Queue'}) as HTMLButtonElement).disabled).toBe(false);
});
it('opens files from the task header while keeping the message timeline and composer mounted',async()=>{
 setup();const view=render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" channelName="hi" onBack={()=>{}} onClose={()=>{}} onAccessLost={()=>{}}/>);
 await screen.findByText('Research prompt');
 const log=screen.getByRole('log',{name:'Session conversation'});
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 expect(log.classList.contains('chat-timeline')).toBe(true);
 expect(log.contains(editor)).toBe(false);
 expect(screen.getByRole('heading',{name:'Research',exact:true,level:1})).toBeTruthy();
 expect(editor.getAttribute('data-placeholder')).toBe('Message Codex');
 expect(view.container.querySelectorAll('.chat-channel-header')).toHaveLength(1);
 expect(view.container.querySelector('.agent-session-header')).toBeNull();
 expect(view.container.querySelector('.chat-channel-topic')).toBeNull();
 const tabs=within(screen.getByRole('tablist',{name:'Session views'}));
 expect(tabs.getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['Messages','Team','Preview','Files 1','Changes 0']);
 expect(screen.queryByRole('button',{name:/unavailable/i})).toBeNull();
 expect(screen.getAllByRole('tablist')).toHaveLength(1);
 expect(screen.getByRole('button',{name:'Bold',exact:true})).toBeTruthy();
 expect(screen.queryByRole('separator',{name:'1 reply'})).toBeNull();
 expect(view.container.querySelectorAll('.sp-conversation-date')).toHaveLength(1);
 await userEvent.type(editor,'Keep this draft');
 await userEvent.click(tabs.getByRole('tab',{name:'Preview'}));
 expect(within(screen.getByRole('tabpanel',{name:'Preview'})).getByText('No preview attached')).toBeTruthy();
 await userEvent.click(tabs.getByRole('tab',{name:'Files 1'}));
 expect(within(screen.getByRole('tabpanel',{name:'Files'})).getByRole('button',{name:'result.txt'})).toBeTruthy();
 await userEvent.click(tabs.getByRole('tab',{name:'Changes 0'}));
 expect(within(screen.getByRole('tabpanel',{name:'Changes'})).getByText('No code changes attached')).toBeTruthy();
 const filesButton=screen.getByRole('button',{name:/Artifacts 1/});
 await userEvent.click(filesButton);
 expect(screen.getByRole('tab',{name:'Files'}).getAttribute('aria-selected')).toBe('true');
 expect(within(screen.getByRole('tabpanel',{name:'Files'})).queryByText('Research')).toBeNull();
 expect(await screen.findByRole('button',{name:'result.txt',exact:true})).toBeTruthy();
 await userEvent.click(screen.getByRole('button',{name:'Close artifacts'}));
 expect(screen.getByRole('textbox',{name:'Message agent session'})).toBe(editor);
 expect(editor.textContent).toContain('Keep this draft');
 expect(document.activeElement).toBe(filesButton);
 expect(log.contains(editor)).toBe(false);
});
it.each(['claude','kiro'])('a %s model without reported effort levels sends only the selected provider model ID',async provider=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 fetch.mockImplementation(async(path,init)=>{
   if(path.endsWith('/models')) return {ok:true,json:async()=>[{id:'auto',label:'Auto',efforts:[],isDefault:true},{id:'sdk-fast',label:'Fast',efforts:[]}]};
   if(path==='/v1/agent-sessions/one') return {ok:true,json:async()=>({session:{...session('one','Research'),skill:provider+'.run'},turns:[],next_cursor:null})};
   return original(path,init);
 });
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Choose model, Auto'}));
 await userEvent.click(screen.getByRole('button',{name:'Select model, Auto'}));
 await userEvent.click(screen.getByRole('button',{name:'Fast',exact:true}));
 expect(screen.queryByRole('slider')).toBeNull();
 const editor=screen.getByRole('textbox',{name:'Message agent session'});
 await userEvent.click(editor);await userEvent.type(editor,'Hello{Enter}');
 await waitFor(()=>expect(fetch.mock.calls.some(([path])=>path.endsWith('/messages'))).toBe(true));
 expect(JSON.parse(String(fetch.mock.calls.find(([path])=>path.endsWith('/messages'))![1]?.body)).codex_settings).toEqual({model:'sdk-fast'});
});
it('renders and sends rich session requests through the shared thread composer',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 const document={ops:[{insert:'Formatted request',attributes:{bold:true}},{insert:'\n'}]};
 fetch.mockImplementation(async(path,init)=>path==='/v1/agent-sessions/one'?{ok:true,json:async()=>({session:session('one','Research'),turns:[{...turn('Formatted request'),task:{...turn('Formatted request').task,request_document:document}}],next_cursor:null})}:original(path,init));
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 const log=await screen.findByRole('log',{name:'Session conversation'});
 expect((await within(log).findByText('Formatted request')).tagName).toBe('STRONG');
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.click(screen.getByRole('button',{name:'Bold',exact:true}));
 await userEvent.click(screen.getByRole('button',{name:'Select model and effort, Connector default, Medium'}));
 expect(screen.queryByText('Preview options')).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'Select model, Connector default'}));
 await userEvent.click(screen.getByRole('button',{name:'Model 42',exact:true}));
 fireEvent.change(screen.getByRole('slider',{name:'Reasoning effort'}),{target:{value:'3'}});
 expect(screen.getByRole('slider').parentElement?.querySelector('.agent-power-max-fill')).toBeTruthy();
 await userEvent.click(editor);
 await userEvent.type(editor,'Next formatted request');await userEvent.keyboard('{Enter}');
 await waitFor(()=>expect(fetch.mock.calls.some(([path])=>path.endsWith('/messages'))).toBe(true));
 const body=JSON.parse(String(fetch.mock.calls.find(([path])=>path.endsWith('/messages'))![1]?.body));
 expect(body.codex_settings).toEqual({model:'sdk-model-42',effort:'ultra'});
 expect(body.text).toBe('Next formatted request');
 expect(body.document.ops.some((op:any)=>op.insert.includes('Next formatted request')&&op.attributes?.bold)).toBe(true);
});

it('offers people and agents as references in the session composer and excludes broadcast tags',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 const agent={kind:'agent',id:'00000000-0000-4000-8000-000000000099',label:'Helper',detail:'Agent',joined:true};
 fetch.mockImplementation(async(path,init)=>path.includes('/mentions?')?{ok:true,json:async()=>({items:[agent,{kind:'broadcast',id:'channel',label:'channel',detail:'Notify channel'}],member_count:2})}:original(path,init));
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.click(screen.getByRole('button',{name:'Mention someone'}));
 const option=await screen.findByRole('option',{name:/Helper/});
 expect(option.textContent).toContain('Reference only');
 expect(screen.queryByRole('option',{name:/Notify channel/})).toBeNull();
 await userEvent.click(option);await userEvent.click(screen.getByRole('button',{name:'Send now'}));
 await waitFor(()=>expect(fetch.mock.calls.filter(([path])=>path.endsWith('/messages'))).toHaveLength(1));
 const [,request]=fetch.mock.calls.find(([path])=>path.endsWith('/messages'))!;
 expect(JSON.parse(String(request?.body)).document.ops.some((op:any)=>op.attributes?.mention?.id===agent.id)).toBe(true);
 expect(fetch.mock.calls.some(([path,init])=>init?.method==='POST'&&path.includes('/channels/channel/messages'))).toBe(false);
});

it('selects persistent sessions by capability and includes the selected skill',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 fetch.mockImplementation(async(path,init)=>path==='/v1/channels/channel/navigator'?{ok:true,json:async()=>({candidates:[{installation_id:'research',name:'Research',skill:'research.review',persistent_sessions:true},{installation_id:'codex-without-sessions',name:'No sessions',skill:'codex.run',persistent_sessions:false}]})}:path==='/v1/channels/channel/agents'?{ok:true,json:async()=>[]}:original(path,init));
 render(<SessionViews/>);
 await userEvent.click(await screen.findByRole('button',{name:'New agent session'}));
 await userEvent.click(screen.getByLabelText('Agent'));
 expect(screen.queryByRole('option',{name:/No sessions/})).toBeNull();
 await userEvent.click(await screen.findByRole('option', { name: 'Research · research.review', exact: true }));
 await userEvent.type(screen.getByLabelText('Session name'),'Review');
 await userEvent.click(screen.getByRole('button',{name:'Start session',exact:true}));
 await waitFor(()=>expect(fetch.mock.calls.some(([path,init])=>path==='/v1/threads/thread/agent-sessions'&&init?.method==='POST'&&JSON.parse(String(init.body)).skill==='research.review')).toBe(true));
});

it('enables only the selected skill when starting a multi-skill session agent',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;let enabled=false;
 fetch.mockImplementation(async(path,init)=>{
  if(path.endsWith('/models'))return [{id:'provider-default',label:'Connector default',efforts:['low','medium'],defaultEffort:'medium',isDefault:true},{id:'sdk-model-42',label:'Model 42',efforts:['low','medium','high','ultra'],defaultEffort:'low'}];
  if(path==='/v1/channels/channel/navigator')return {ok:true,json:async()=>({candidates:enabled?[{installation_id:'research',name:'Research',skill:'research.review',persistent_sessions:true}]:[]})};
  if(path==='/v1/channels/channel/agents')return {ok:true,json:async()=>[{id:'research',name:'Research',skills:['research.run','research.review'],granted_skills:enabled?['research.review']:[],enabled_in_channel:enabled,persistent_sessions:true}]};
  if(path==='/v1/agents/connections/research/channels/channel'){enabled=true;return {ok:true,json:async()=>({})};}
  return original(path,init);
 });
 render(<SessionViews/>);
 await userEvent.click(await screen.findByRole('button',{name:'New agent session'}));
 await userEvent.click(await screen.findByRole('button',{name:'Enable Research · research.review in this channel'}));
 const grant=fetch.mock.calls.find(([path])=>path==='/v1/agents/connections/research/channels/channel');
 expect(JSON.parse(String(grant?.[1]?.body))).toEqual({enabled:true,skill:'research.review'});
 await userEvent.click(screen.getByRole('combobox', { name: 'Agent' })); expect(await screen.findByRole('option',{name:'Research · research.review'})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Enable Research · research.run in this channel'})).toBeTruthy();
});


it('shows agent activity above the shared composer, reuses the tool timeline and clears terminal activity',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;let phase='thinking',running=true;
 fetch.mockImplementation(async(path,init)=>path==='/v1/agent-sessions/one'?{ok:true,json:async()=>({session:session('one','Research'),turns:[{...turn('Research prompt'),task:{...turn('Research prompt').task,status:running?'running':'completed'},response:{messages:[],tools:phase==='using_tools'?[{id:'read',name:'read_text_file',arguments:'{"path":"README.md"}',status:'running'}]:[],components:[],activity:phase}}],next_cursor:null})}:original(path,init));
 render(<SessionViews/>);await userEvent.click(await screen.findByRole('button',{name:'Research',exact:true}));
 const editor=await screen.findByRole('textbox',{name:'Message agent session'}),compose=editor.closest('.chat-compose')!;
 expect(await within(compose as HTMLElement).findByText('is thinking…')).toBeTruthy();
 const indicator=compose.querySelector('.chat-typing')!;expect(indicator.compareDocumentPosition(compose.querySelector('.sp-rich-composer')!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 phase='using_tools';await act(async()=>{await mocks.refresh?.();});
 expect(await within(compose as HTMLElement).findByText('is using tools…')).toBeTruthy();expect(await screen.findByText('read_text_file · Running')).toBeTruthy();
 expect(within(screen.getByRole('log',{name:'Session conversation'})).queryByText('Using tools…')).toBeNull();
 phase='responding';await act(async()=>{await mocks.refresh?.();});expect(await within(compose as HTMLElement).findByText('is responding…')).toBeTruthy();
 running=false;await act(async()=>{await mocks.refresh?.();});await waitFor(()=>expect(indicator.textContent).toBe(''));
 expect(screen.getByRole('textbox',{name:'Message agent session'})).toBe(editor);
});

it('acknowledges a pending accepted send after the session page unmounts without restoring its draft',async()=>{
 const fetch=setup(), original=fetch.getMockImplementation()!;
 const message='Accepted while away', key='session:channel:one';
 const response=Promise.withResolvers<ReturnType<typeof turn>['task']>();
 const accepted=Promise.withResolvers<void>();
 fetch.mockImplementation((path,init)=>path==='/v1/agent-sessions/one/messages' && init?.method==='POST'
  ? Promise.resolve({ok:true,json:()=>response.promise}) : original(path,init));
 const drafts:Record<string,RichDocument>={},attempt:MessageAttempt={};
 const props={thread:'thread',channel:'channel',viewerId:'user',initialSessionId:'one',onAccessLost:()=>{},
  drafts,attempt:()=>attempt,onAccepted:()=>accepted.resolve()};
 async function openSession() {
  const view=render(<AgentSessions {...props}/>);
  // Flush the session read before waiting for the composer's lazy Quill import.
  await act(async()=>{});
  await act(()=>vi.dynamicImportSettled());
  return {view,editor:within(view.container).getByRole('textbox',{name:'Message agent session'})};
 }
 const {view,editor}=await openSession();
 await userEvent.type(editor,message);
 await userEvent.click(screen.getByRole('button',{name:'Send now'}));
 expect(attempt.current).toBeDefined();
 expect(documentText(drafts[key]!).trimEnd()).toBe(message);
 view.unmount();
 response.resolve({...turn(message).task,status:'queued'});
 await accepted.promise;
 expect(drafts[key]).toEqual({ops:[]});
 expect(attempt.current).toBeUndefined();
 const reopened=await openSession();
 expect(reopened.editor.textContent?.trim()).toBe('');
});
it('retains a failed send identity and draft across session page remounts',async()=>{
 setup();const original=vi.mocked(fetch).getMockImplementation()!;let failing=true;const keys:string[]=[];
 vi.mocked(fetch).mockImplementation(async(...args)=>{
  if(String(args[0]).endsWith('/messages')){keys.push(String((args[1]?.headers as Record<string,string>)['idempotency-key']));if(failing)throw new Error('offline');}
  return original(...args);
 });
 const drafts:Record<string,any>={},attempt:any={};
 const props={thread:'thread',channel:'channel',viewerId:'user',initialSessionId:'one',onAccessLost:()=>{},drafts,attempt:()=>attempt};
 const view=render(<AgentSessions {...props}/>);
 await userEvent.type(await screen.findByRole('textbox',{name:'Message agent session'}),'Retry after navigation');
 await userEvent.click(screen.getByRole('button',{name:'Send now'}));await screen.findByRole('alert');view.unmount();failing=false;
 render(<AgentSessions {...props}/>);
 expect((await screen.findByRole('textbox',{name:'Message agent session'})).textContent).toContain('Retry after navigation');
 await userEvent.click(screen.getByRole('button',{name:'Send now'}));await waitFor(()=>expect(keys).toHaveLength(2));
 expect(keys[1]).toBe(keys[0]);
});

it('clears a remounted composer when its previous pending send is accepted',async()=>{
 setup();const original=vi.mocked(fetch).getMockImplementation()!;
 let finish!:(task:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
 vi.mocked(fetch).mockImplementation(async(...args)=>String(args[0]).endsWith('/messages')?{ok:true,json:async()=>pending} as Response:original(...args));
 const drafts:Record<string,any>={},attempt:any={};
 function Harness({visible}:{visible:boolean}) {
  const [acknowledged,setAcknowledged]=useState<Record<string,any>>({});
  return visible?<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}} drafts={drafts} attempt={()=>attempt} acknowledged={acknowledged} onAccepted={(key,document)=>setAcknowledged(old=>({...old,[key]:document}))}/>:null;
 }
 const view=render(<Harness visible/>);
 async function readyEditor() {
  await screen.findByText('Research prompt');
  await act(async()=>{await vi.dynamicImportSettled();});
  return screen.getByRole('textbox',{name:'Message agent session'});
 }
 await userEvent.type(await readyEditor(),'Accepted after return');
 await userEvent.click(screen.getByRole('button',{name:'Send now'}));
 expect(vi.mocked(fetch).mock.calls.some(([path])=>String(path).endsWith('/one/messages'))).toBe(true);
 view.rerender(<Harness visible={false}/>);view.rerender(<Harness visible/>);
 const editor=await readyEditor();
 expect(editor.textContent).toContain('Accepted after return');
 await act(async()=>{finish({...turn('Accepted after return').task,status:'queued'});await pending;});
 await waitFor(()=>expect(editor.textContent?.trim()).toBe(''));
 expect(attempt.current).toBeUndefined();
});

it('shows the agent session introduction, conversation details menu, and file navigation without losing drafts',async()=>{
 setup();render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 const introduction=await screen.findByText(/Codex was invited to this agent session/);
 expect(introduction.closest('.dm-conversation-intro')).toBeTruthy();
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.type(editor,'Keep this draft');
 await userEvent.click(screen.getByRole('button',{name:'More conversation actions'}));
 await userEvent.click(screen.getByRole('menuitem',{name:'Conversation details'}));
 expect(within(screen.getByRole('dialog',{name:'Conversation details'})).getByText('Research')).toBeTruthy();
 await userEvent.click(screen.getByRole('button',{name:'Close dialog'}));
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 await userEvent.click(screen.getByRole('button',{name:'More conversation actions'}));
 await userEvent.click(screen.getByRole('menuitem',{name:'Browse files'}));
 expect(screen.getByRole('tabpanel',{name:'Files'})).toBeTruthy();
 await userEvent.click(screen.getByRole('button',{name:'Close artifacts'}));
 expect(screen.getByRole('textbox',{name:'Message agent session'})).toBe(editor);
 expect(editor.textContent).toContain('Keep this draft');
});
it('extends the same agent conversation with selected context instead of replacing its introduction',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 const context={channel_id:'source',channel_name:'product',captured_at:'2026-11-04T09:00:00Z',messages:[{id:'selected',thread_id:'source-thread',author:'Maya',text:'Selected source message',created_at:'2026-11-04T08:55:00Z',files:[]}]};
 fetch.mockImplementation(async(path,init)=>path==='/v1/agent-sessions/one'?{ok:true,json:async()=>({session:session('one','Research'),turns:[turn('Research prompt')],next_cursor:null,context})}:original(path,init));
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onClose={()=>{}} onAccessLost={()=>{}}/>);
 const introduction=await screen.findByText('This is the beginning of your conversation with Codex.');
 const selected=screen.getByRole('region',{name:'Selected messages'}),request=screen.getByText('Research prompt');
 expect(introduction.compareDocumentPosition(selected)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(selected.compareDocumentPosition(request)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.getByRole('button',{name:'Close agent session'})).toBeTruthy();
 expect(screen.getByRole('tablist',{name:'Session views'})).toBeTruthy();
 expect(await screen.findByRole('textbox',{name:'Message agent session'})).toBeTruthy();
 expect(screen.getAllByRole('log',{name:'Session conversation'})).toHaveLength(1);
});

it('stars and unstars the selected agent session from its conversation header',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;let active=false;
 fetch.mockImplementation(async(path,init)=>{
  if(path==='/v1/workspaces/workspace/hub/starred-sessions/one'){
   if(init?.method==='POST')active=JSON.parse(String(init.body)).active;
   return {ok:true,json:async()=>({active})};
  }
  return original(path,init);
 });
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Star conversation'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Unstar conversation'}).getAttribute('aria-pressed')).toBe('true'));
 expect(active).toBe(true);
 await userEvent.click(screen.getByRole('button',{name:'Unstar conversation'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Star conversation'}).getAttribute('aria-pressed')).toBe('false'));
 expect(active).toBe(false);
});

it('keeps a rejected immediate-turn draft and uses a fresh attempt when the connector becomes available',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;let sends=0;
 fetch.mockImplementation(async(path,init)=>path.endsWith('/messages')&&++sends===1?{ok:false,status:409,json:async()=>({error:'agent_unavailable'})}:original(path,init));
 render(<SessionViews/>);await userEvent.click(await screen.findByRole('button',{name:'Research',exact:true}));
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});await userEvent.type(editor,'Please continue');await userEvent.keyboard('{Enter}');
 expect((await screen.findByRole('alert')).textContent).toBe('Your local connector is unavailable. Reconnect it and send again.');
 expect(editor.textContent).toContain('Please continue');await userEvent.click(screen.getByRole('button',{name:'Send now'}));
 await waitFor(()=>expect(editor.textContent?.trim()).toBe(''));
 const attempts=fetch.mock.calls.filter(([path])=>path.endsWith('/messages'));expect(attempts).toHaveLength(2);
 expect(new Headers(attempts[0]![1]?.headers).get('idempotency-key')).not.toBe(new Headers(attempts[1]![1]?.headers).get('idempotency-key'));
});

it('sends the objective through the session composer and restores confirmed status after reopening',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 let goal: {objective:string;status:string}|null=null;
 const sent:any[]=[];
 fetch.mockImplementation(async(path,init)=>{
  if(path==='/v1/agent-sessions/one/messages') {
   const body=JSON.parse(String(init?.body));sent.push(body);
   goal=body.goal_action.kind==='set'?{objective:body.goal_action.objective,status:'active'}:null;
   return {ok:true,json:async()=>({id:'Research prompt'})};
  }
  if(path==='/v1/agent-sessions/one') return {ok:true,json:async()=>({session:session('one','Research'),turns:[turn('Research prompt')],next_cursor:null,session_goal:goal})};
  return original(path,init);
 });
 const view=()=>render(<AgentSessions thread="thread" channel="channel" viewerId="user" onAccessLost={()=>{}} initialSessionId="one"/>);
 const first=view();
 await userEvent.click(await screen.findByRole('button',{name:'Add to message'}));
 await userEvent.click(await screen.findByRole('menuitem',{name:'Set goal'}));
 const editor=screen.getByRole('textbox',{name:'Message agent session'});
 expect(document.activeElement).toBe(editor);
 await userEvent.type(editor,'The checks pass');
 await userEvent.click(screen.getByRole('button',{name:'Exit goal mode'}));
 expect(document.activeElement).toBe(editor);
 expect(editor.textContent?.trim()).toBe('The checks pass');
 expect(screen.queryByRole('button',{name:'Exit goal mode'})).toBeNull();
 expect(sent).toHaveLength(0);
 await userEvent.click(screen.getByRole('button',{name:'Add to message'}));
 await userEvent.click(await screen.findByRole('menuitem',{name:'Set goal'}));
 await userEvent.click(screen.getByRole('button',{name:'Send now'}));
 await screen.findByText('Pursuing goal');
 expect(screen.queryByRole('button',{name:'Exit goal mode'})).toBeNull();
 expect(sent[0]).toMatchObject({goal_action:{kind:'set',objective:'The checks pass'},codex_settings:{effort:'medium'}});
 first.unmount();view();
 await screen.findByText('The checks pass');
 await userEvent.click(screen.getByRole('button',{name:'Clear goal'}));
 await userEvent.click(await screen.findByRole('button',{name:'Add to message'}));
 await screen.findByRole('menuitem',{name:'Set goal'});
 expect(sent[1].goal_action).toEqual({kind:'clear'});
});

it('sends follow-ups in the same session with the current tab address',async()=>{
 const fetch=setup(),props={thread:'thread',channel:'channel',viewerId:'user',initialSessionId:'one',onAccessLost:()=>{}};
 const original=fetch.getMockImplementation()!,completed=[turn('Research prompt')];
 fetch.mockImplementation(async(path,init)=>{
   if(path.endsWith('/messages')){const next=turn(JSON.parse(String(init?.body)).text);completed.push(next);return {ok:true,json:async()=>next.task};}
   if(path==='/v1/agent-sessions/one')return {ok:true,json:async()=>({session:session('one','Research'),turns:[...completed],next_cursor:null})};
   return original(path,init);
 });
 const view=render(<AgentSessions {...props} browserPage="https://github.com/org/repo"/>);
 const editor=await screen.findByRole('textbox',{name:'Message agent session'});
 await userEvent.type(editor,'Summarize this');await userEvent.keyboard('{Enter}');
 await waitFor(()=>expect(editor.textContent?.trim()).toBe(''));
 await act(async()=>{await mocks.refresh?.();});
 view.rerender(<AgentSessions {...props} browserPage="https://github.com/org/repo/pull/1"/>);
 await userEvent.type(editor,'What changed?');await userEvent.keyboard('{Enter}');
 const messages=()=>fetch.mock.calls.filter(([path])=>path==='/v1/agent-sessions/one/messages').map(([,init])=>JSON.parse(String(init?.body)));
 await waitFor(()=>expect(messages()).toMatchObject([
   {text:'Summarize this',browser_url:'https://github.com/org/repo'},
   {text:'What changed?',browser_url:'https://github.com/org/repo/pull/1'},
 ]));
 for(const message of messages()) expect(message.document.ops.map((op:{insert:string})=>op.insert).join('').trim()).toBe(message.text);
});

it('submits the patch review to this session without consuming the conversation draft',async()=>{
 const {webcrypto}=await import('node:crypto');vi.stubGlobal('crypto',webcrypto);
 const fetch=setup(),original=fetch.getMockImplementation()!;
 fetch.mockImplementation(async(path,init)=>path==='/v1/agent-sessions/one'?{ok:true,json:async()=>({
   session:session('one','Patch review'),turns:[turn('Review')],next_cursor:null,
   outputs:{files:[],changes:[{path:'init.ts',patch:'@@ -0,0 +1 @@\n+init();'}]},
 })}:original(path,init));
 const user=userEvent.setup();
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 await user.type(await screen.findByRole('textbox',{name:'Message agent session'}),'Draft for later');
 await user.click(screen.getByRole('button',{name:/Artifacts 1/}));
 await user.click(screen.getByRole('button',{name:'Comment on init.ts, new line 1'}));
 await user.type(screen.getByRole('textbox',{name:/Comment on init.ts/}),'Handle initialization errors.');
 await user.click(screen.getByRole('button',{name:'Add to review'}));
 await user.click(screen.getByRole('button',{name:'Close artifacts'}));
 await user.click(screen.getByRole('button',{name:/Artifacts 1/}));
 await user.click(screen.getByRole('button',{name:'Submit review'}));
 await user.click(screen.getByRole('button',{name:'Send review'}));
 const composer=await screen.findByRole('textbox',{name:'Message agent session'});
 expect(composer.textContent).toContain('Draft for later');
 const req=fetch.mock.calls.filter(([path])=>path==='/v1/agent-sessions/one/queue');
 expect(req).toHaveLength(1);
 expect(JSON.parse(String(req[0]![1]!.body)).text).toContain('Handle initialization errors.');
 expect(new Headers(req[0]![1]!.headers).get('idempotency-key')).toBeTruthy();
});

it('routes the agent reply toolbar to the response and reserves edit and delete for the requester',async()=>{
 const fetch=setup();
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 const group=await screen.findByRole('group',{name:'Message actions for Codex'});
 await userEvent.hover(group.closest('article')!);
 await userEvent.click(within(group).getByLabelText('More actions'));
 const menu=screen.getByRole('menu',{name:'Message actions'});
 expect(within(menu).queryByRole('menuitem',{name:'Edit message'})).toBeNull();
 expect(within(menu).queryByRole('menuitem',{name:'Delete message…'})).toBeNull();
 await userEvent.click(within(menu).getByRole('menuitem',{name:'Pin to session'}));
 expect(fetch.mock.calls.some(([path,init])=>path.endsWith('/turns/Research prompt/messages/response')&&init?.body===JSON.stringify({action:'pin',active:true}))).toBe(true);
 const ownActions=screen.getByRole('group',{name:'Message actions for Kai'});
 await userEvent.hover(ownActions.closest('article')!);
 await userEvent.click(within(ownActions).getByLabelText('More actions'));
 await userEvent.click(screen.getByRole('menuitem',{name:'Delete message…'}));
 await userEvent.click(within(screen.getByRole('dialog',{name:'Delete message?'})).getByRole('button',{name:'Cancel'}));
 expect(fetch.mock.calls.some(([,init])=>init?.body===JSON.stringify({action:'delete'}))).toBe(false);
});

it('shows reviewer comments in Messages and sends team discussion without prompting the agent',async()=>{
 const fetch=setup(), original=fetch.getMockImplementation()!;
 const messages=[{sequence:'1',author:'Sam',author_id:'sam',body:'Ready for review',created_at:'2026-11-03T01:00:00Z'}];
 fetch.mockImplementation(async(path,init)=>{
   if(path.endsWith('/team/discussion')){
     if(init?.method==='POST')messages.push({...messages[0]!,sequence:'2',body:JSON.parse(String(init.body)).text});
     return {ok:true,json:async()=>({messages:[...messages],before:null,writable:true})};
   }
   if(path.endsWith('/team'))return {ok:true,json:async()=>({reviewers:[],shared:[],messages,workspace_id:'workspace',viewer_id:'user',can_manage:true,writable:true})};
   return original(path,init);
 });
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 expect(await within(await screen.findByRole('log',{name:'Session conversation'})).findByText('Ready for review')).toBeTruthy();
 await userEvent.type(await screen.findByRole('textbox',{name:'Message agent session'}),'Keep this prompt');
 await userEvent.click(screen.getByRole('button',{name:'Message recipient'}));
 await userEvent.click(screen.getByRole('menuitem',{name:'Team discussion'}));
 const editor=await screen.findByRole('textbox',{name:'Message team discussion'});
 await userEvent.type(editor,'Looks good{Enter}');
 expect(await screen.findByText('Looks good',{selector:'.sp-message-text *'})).toBeTruthy();
 expect(fetch.mock.calls.filter(([path,init])=>init?.method==='POST'&&/(?:messages|queue|steer)$/.test(path))).toHaveLength(0);
 await userEvent.click(screen.getByRole('button',{name:'Message recipient'}));
 await userEvent.click(screen.getByRole('menuitem',{name:'Message Codex'}));
 expect((await screen.findByRole('textbox',{name:'Message agent session'})).textContent).toContain('Keep this prompt');
 await userEvent.click(screen.getByRole('tab',{name:'Team'}));
 const team=screen.getByRole('tabpanel',{name:'Team'});
 expect(await within(team).findByText('People and access')).toBeTruthy();
 expect(within(team).queryByRole('textbox',{name:'Message the team'})).toBeNull();
});

it.each(['Invite as reviewer instead','Add to Channel','Send This Message'])('defers tag-only sends until the user chooses %s',async label=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 const person={kind:'user',id:'00000000-0000-4000-8000-000000000099',label:'Riley',detail:'Designer',joined:false,can_invite_reviewer:true,invite_channel:'design'};
 fetch.mockImplementation(async(path,init)=>{
   if(path.includes('/team/mentions?'))return {ok:true,json:async()=>({items:[person],member_count:1})};
   if(path.endsWith('/team/discussion'))return {ok:true,json:async()=>({messages:[],before:null,writable:true})};
   return original(path,init);
 });
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Add people'}));
 expect(screen.queryByRole('dialog')).toBeNull();
 await userEvent.click(await screen.findByRole('option',{name:/Riley/}));
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(screen.queryByRole('button',{name:'Add to Channel'})).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'Send now'}));
 const dialog=await screen.findByRole('dialog',{name:'Want to add this person instead?'});
 const writes=()=>fetch.mock.calls.filter(([path,init])=>['POST','PUT'].includes(init?.method??'')&&/\/(members|discussion|messages|reviewers\/[^/]+)$/.test(path));
 expect(writes()).toHaveLength(0);
 await userEvent.click(within(dialog).getByRole('button',{name:label}));
 const expected=label.startsWith('Invite')?'/team/reviewers/'+person.id:label.startsWith('Add')?'/channels/channel/members':'/team/discussion';
 await waitFor(()=>expect(writes().map(([path])=>path)).toEqual(['/v1'+(expected.startsWith('/channels')?'':'/agent-sessions/one')+expected]));
 await waitFor(()=>expect(screen.getByRole('textbox',{name:'Message team discussion'}).textContent?.trim()).toBe(''));

});

it('posts a tagged team message and then offers an optional invitation',async()=>{
 const fetch=setup(),original=fetch.getMockImplementation()!;
 const person={kind:'user',id:'00000000-0000-4000-8000-000000000099',label:'Riley',joined:false,can_invite_reviewer:true,invite_channel:null};
 fetch.mockImplementation(async(path,init)=>{
   if(path.includes('/team/mentions?'))return {ok:true,json:async()=>({items:[person],member_count:1})};
   if(path.endsWith('/team/discussion'))return {ok:true,json:async()=>({messages:[],writable:true})};
   return original(path,init);
 });
 render(<AgentSessions thread="thread" channel="channel" viewerId="user" initialSessionId="one" onAccessLost={()=>{}}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Add people'}));
 await userEvent.click(await screen.findByRole('option',{name:/Riley/}));
 const editor=screen.getByRole('textbox',{name:'Message team discussion'});
 await userEvent.keyboard('please review');
 await userEvent.click(screen.getByRole('button',{name:'Send now'}));
 const invite=await screen.findByRole('button',{name:'Invite as reviewer'});
 await waitFor(()=>expect(editor.textContent?.trim()).toBe(''));
 expect(fetch.mock.calls.filter(([path,init])=>path.endsWith('/discussion')&&init?.method==='POST')).toHaveLength(1);
 expect(JSON.parse(String(fetch.mock.calls.find(([path,init])=>path.endsWith('/discussion')&&init?.method==='POST')![1]?.body)).document.ops[0].attributes.mention.id).toBe(person.id);
 await userEvent.click(screen.getByRole('button',{name:'Dismiss'}));
 await waitFor(()=>expect(invite.isConnected).toBe(false));
 expect(fetch.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
});
