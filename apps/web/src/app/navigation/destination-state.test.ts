import {expect,it} from 'vitest';
import {conversationView,createWorkspaceViewState} from './destination-state.js';
it('bounds room snapshots and retains the most recently visited conversations',()=>{
 const {rooms}=createWorkspaceViewState();
 const first=conversationView(rooms,'0');first.current.thread='thread';
 for(let index=1;index<32;index++)conversationView(rooms,String(index));
 expect(conversationView(rooms,'0')).toBe(first);conversationView(rooms,'32');
 expect(rooms.size).toBe(32);expect(rooms.has('1')).toBe(false);expect(rooms.get('0')?.current.thread).toBe('thread');
});
it('starts a fresh UI snapshot when workspace scope changes',()=>{
 const previous=createWorkspaceViewState();previous.activity.current.kind='mention';conversationView(previous.rooms,'room').current.sessionOpen=true;
 const next=createWorkspaceViewState();expect(next.activity.current.kind).toBe('');expect(next.rooms.size).toBe(0);
});
