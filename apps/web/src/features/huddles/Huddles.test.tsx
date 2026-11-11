import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,waitFor,cleanup,act,fireEvent} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const mocks=vi.hoisted(()=>({request:vi.fn(),rooms:[] as any[],listeners:[] as {scope:string;id:string;read:()=>Promise<void>;revoke:()=>void}[]}));
vi.mock('../../shared/api/request.js',()=>({request:mocks.request}));
vi.mock('../../shared/realtime/live-updates.js',()=>({invalidateUpdates:vi.fn(),subscribeUpdates:(scope:string,id:string,read:()=>Promise<void>,revoke:()=>void)=>{const listener={scope,id,read,revoke};mocks.listeners.push(listener);void read();return()=>{mocks.listeners=mocks.listeners.filter(x=>x!==listener);};}}));
vi.mock('livekit-client',()=>({
 Room:class{remoteParticipants=new Map();connect=vi.fn(async()=>{});disconnect=vi.fn(async()=>{});once=vi.fn();localParticipant={setMicrophoneEnabled:vi.fn(async()=>{}),setCameraEnabled:vi.fn(async()=>{}),setScreenShareEnabled:vi.fn(async()=>{})};constructor(){mocks.rooms.push(this);}},
 RoomEvent:{Disconnected:'disconnected'},ConnectionState:{Connected:'connected'},Track:{Source:{Camera:'camera',ScreenShare:'screen_share'}}
}));
vi.mock('@livekit/components-react',async()=>{
 const {createContext}=await import('react');
 return {RoomContext:createContext(null),RoomAudioRenderer:()=>null,StartAudio:()=>null,ParticipantTile:()=>null,useTracks:()=>[],useConnectionState:()=> 'connected',useLocalParticipant:()=>({localParticipant:mocks.rooms.at(-1)?.localParticipant,isMicrophoneEnabled:true,isCameraEnabled:false,isScreenShareEnabled:false}),useMediaDeviceSelect:()=>({devices:[],activeDeviceId:'',setActiveMediaDevice:vi.fn()})};
});
import {HuddleProvider,HuddleButton,Huddles} from './Huddles.js';
const huddle={id:'huddle',channel_id:'channel',workspace_id:'workspace',channel_name:'design',state:'active',created_at:'2026-11-06'};
HTMLDialogElement.prototype.showModal=function(){this.open=true;};
HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
beforeEach(()=>{mocks.rooms=[];mocks.listeners=[];mocks.request.mockReset();mocks.request.mockImplementation(async(path:string)=>path==='/huddles/config'?{enabled:true}:path.endsWith('/join')?{huddle,token:'short-lived-token',url:'ws://localhost:7880'}:path.includes('/workspaces/')?{items:[huddle],next_cursor:null}:huddle);});
afterEach(cleanup);
function mount(){return render(<HuddleProvider><HuddleButton channel="channel" name="design"/></HuddleProvider>);}
async function join(){await userEvent.click(await screen.findByRole('button',{name:'Join huddle'}));const dialog=screen.getByRole('dialog');expect(dialog).toBeTruthy();await userEvent.click(screen.getAllByRole('button',{name:'Join huddle'}).at(-1)!);await screen.findByRole('region',{name:'Channel huddle'});}

it('asks before joining, keeps camera off, and releases media when leaving',async()=>{
 mount();await screen.findByRole('button',{name:'Join huddle'});expect(mocks.rooms).toHaveLength(0);
 await join();const room=mocks.rooms[0];expect(room.connect).toHaveBeenCalledWith('ws://localhost:7880','short-lived-token');
 await waitFor(()=>expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true));expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'Leave'}));expect(room.disconnect).toHaveBeenCalledWith(true);
});
it('can join muted and keeps audio connected while minimized',async()=>{
 mount();await userEvent.click(await screen.findByRole('button',{name:'Join huddle'}));
 await userEvent.click(screen.getByRole('checkbox'));await userEvent.click(screen.getAllByRole('button',{name:'Join huddle'}).at(-1)!);
 await screen.findByRole('region',{name:'Channel huddle'});expect(mocks.rooms[0].localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'Minimize huddle'}));expect(mocks.rooms[0].disconnect).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'Expand huddle'}));expect(mocks.rooms).toHaveLength(1);
});
it('drops media immediately when channel access is revoked',async()=>{
 mount();await join();await act(async()=>{mocks.listeners.find(x=>x.scope==='channel'&&x.revoke)?.revoke();});
 expect(mocks.rooms[0].disconnect).toHaveBeenCalledWith(true);expect(screen.queryByRole('region',{name:'Channel huddle'})).toBeNull();
});
it('does not connect a late admission after cancelling the join dialog',async()=>{
 let complete!:(value:unknown)=>void;const admission=new Promise(resolve=>complete=resolve);
 mocks.request.mockImplementation(async(path:string)=>path==='/huddles/config'?{enabled:true}:path.endsWith('/join')?admission:huddle);
 mount();await userEvent.click(await screen.findByRole('button',{name:'Join huddle'}));await userEvent.click(screen.getAllByRole('button',{name:'Join huddle'}).at(-1)!);
 fireEvent(screen.getByRole('dialog'),new Event('close'));await act(async()=>{complete({huddle,token:'late',url:'ws://localhost'});await admission;});
 expect(mocks.rooms[0].connect).not.toHaveBeenCalled();expect(mocks.rooms[0].disconnect).toHaveBeenCalledWith(true);
});
it('shows active authorized rooms and clears them on workspace revocation',async()=>{
 render(<HuddleProvider><Huddles workspace="workspace" onOpenChannel={vi.fn()}/></HuddleProvider>);
 await screen.findByRole('button',{name:'#design'});await act(async()=>{mocks.listeners.find(x=>x.scope==='workspace')!.revoke();});
 expect(screen.queryByRole('button',{name:'#design'})).toBeNull();expect(screen.getByRole('alert').textContent).toContain('no longer have access');
});

it('opens a copied channel huddle link at the prejoin dialog before requesting media', async () => {
 const original=location.pathname+location.search;
 const id='550e8400-e29b-41d4-a716-446655440000';
 const originalRequest=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async (path:string,...args:unknown[]) => path==='/channels/'+id
  ? {id,name:'design',joined:true,kind:'channel',archived_at:null} : originalRequest(path,...args));
 history.replaceState(null,'','/c/VQ6EAOKbQdSnFkRmVUQAAA?huddle=1');
 try {
  mount();
  await screen.findByRole('dialog',{name:'Join huddle in #design'});
  expect(mocks.rooms).toHaveLength(0);
  expect(mocks.request.mock.calls.some(([path])=>String(path).endsWith('/join'))).toBe(false);
 } finally { history.replaceState(null,'',original); }
});
