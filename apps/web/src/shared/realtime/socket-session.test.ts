import { afterEach, expect, it, vi } from 'vitest';
import { acquireRealtime, retainRealtimeSession } from './socket-session.js';
import { invalidateSocketCommands, socketCommand } from './socket-command.js';
import type { Socket } from 'socket.io-client';
const clients=vi.hoisted(()=>[] as any[]);
vi.mock('socket.io-client',()=>({io:()=>{
 const handlers=new Map<string,(...args:any[])=>void>();
 const socket={connected:false,active:false,
  on:vi.fn((name:string,handler:(...args:any[])=>void)=>{handlers.set(name,handler);}),
  off:vi.fn((name:string,handler:(...args:any[])=>void)=>{if(handlers.get(name)===handler)handlers.delete(name);}),
  connect:vi.fn(()=>{socket.connected=true;socket.active=true;handlers.get('connect')?.();}),
  disconnect:vi.fn(()=>{socket.connected=false;socket.active=false;handlers.get('disconnect')?.('io client disconnect');}),
  receive:(name:string,...args:any[])=>handlers.get(name)?.(...args),
 };
 clients.push(socket);return socket;
}}));
const releases=new Set<()=>void>();
afterEach(()=>{for(const release of releases)release();releases.clear();clients.length=0;});
it('keeps one connection through navigation until the signed-in owner leaves',()=>{
 const end=retainRealtimeSession();releases.add(end);
 const first=acquireRealtime(), second=acquireRealtime();releases.add(first.release);releases.add(second.release);
 expect(clients).toHaveLength(1);expect(first.socket).toBe(second.socket);
 first.release();second.release();expect(clients[0].disconnect).not.toHaveBeenCalled();
 const next=acquireRealtime();releases.add(next.release);expect(clients).toHaveLength(1);next.release();
 end();expect(clients[0].disconnect).toHaveBeenCalledTimes(1);
});
it('registers one event dispatcher, acknowledges once, and removes only the departing listener',()=>{
 const a=acquireRealtime(),b=acquireRealtime();releases.add(a.release);releases.add(b.release);
 const first=vi.fn(),second=vi.fn(),ack=vi.fn();
 a.on('chat.events',first);b.on('chat.events',second);
 expect(clients[0].on.mock.calls.filter(([name]:any[])=>name==='chat.events')).toHaveLength(1);
 clients[0].receive('chat.events',{cursor:'1'},ack);
 expect(first).toHaveBeenCalledTimes(1);expect(second).toHaveBeenCalledTimes(1);expect(ack).toHaveBeenCalledTimes(1);
 a.release();clients[0].receive('chat.events',{cursor:'2'},ack);
 expect(first).toHaveBeenCalledTimes(1);expect(second).toHaveBeenCalledTimes(2);
 b.release();expect(clients[0].off).toHaveBeenCalledWith('chat.events',expect.any(Function));
});
it('closes an expired session and notifies every subscribed view',()=>{
 const end=retainRealtimeSession();releases.add(end);
 const a=acquireRealtime(),b=acquireRealtime();releases.add(a.release);releases.add(b.release);
 const first=vi.fn(),second=vi.fn();a.on('session.revoked',first);b.on('session.revoked',second);
 window.dispatchEvent(new Event('space:session-expired'));
 expect(first).toHaveBeenCalledTimes(1);expect(second).toHaveBeenCalledTimes(1);
 expect(clients[0].connected).toBe(false);
 a.connect();expect(clients[0].connect).toHaveBeenCalledTimes(1);
});
it('serializes subscription and send commands without replaying queued work on a replacement connection',async()=>{
 let finish!:(value:unknown)=>void;
 const rpc=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({data:'sent'});
 const socket={connected:true,timeout:()=>({emitWithAck:rpc})} as unknown as Socket;
 const subscribe=socketCommand(socket,'channel.subscribe',{channel_id:'a'});
 const send=socketCommand(socket,'message.send',{text:'Hello'});
 const first=expect(subscribe).rejects.toThrow('Connection changed');
 const second=expect(send).rejects.toThrow('Connection changed');
 await Promise.resolve();expect(rpc).toHaveBeenCalledTimes(1);
 invalidateSocketCommands(socket);finish({data:'subscribed'});
 await Promise.all([first,second]);expect(rpc).toHaveBeenCalledTimes(1);
 await expect(socketCommand(socket,'channel.subscribe',{channel_id:'b'})).resolves.toBe('sent');
});
it('acknowledges a requested receipt only after a view accepts the live batch', () => {
 const lease = acquireRealtime(); releases.add(lease.release);
 const frame = { channel_id: 'current', receipt_requested: true };
 const off = lease.on('chat.events', () => false), ack = vi.fn();
 clients[0].receive('chat.events', frame, ack);
 expect(ack).not.toHaveBeenCalledWith(true);
 off(); lease.on('chat.events', () => true);
 clients[0].receive('chat.events', frame, ack);
 expect(ack).toHaveBeenLastCalledWith(true);
 clients[0].receive('chat.events', { channel_id: 'current' }, ack);
 expect(ack).toHaveBeenLastCalledWith();
});
it('times message submission through confirmation on the sending browser and expires the clock on disconnect', async () => {
 const lease = acquireRealtime(); releases.add(lease.release);
 const socket = clients[0]; lease.connect();
 const emit = vi.fn().mockResolvedValue({ data: {} });
 socket.timeout = () => ({ emitWithAck: emit });
 await socketCommand(socket, 'message.send', { text: 'old API' });
 expect(emit.mock.calls[0]?.[1]).toEqual({ text: 'old API' });
 const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
 try {
   socket.receive('chat.receipts.enabled');
   await socketCommand(socket, 'message.send', { text: 'measured' });
   const id = emit.mock.calls[1]?.[1].receipt_id;
   expect(id).toEqual(expect.any(String));
   clock.mockReturnValue(280);
   const ack = vi.fn();
   socket.receive('chat.receipt.confirmed', id, ack);
   expect(ack).toHaveBeenLastCalledWith(180);
   socket.receive('chat.receipt.confirmed', id, ack);
   expect(ack).toHaveBeenLastCalledWith(null);
   await socketCommand(socket, 'message.send', { text: 'interrupted' });
   socket.disconnect();
   socket.receive('chat.receipt.confirmed', emit.mock.calls[2]?.[1].receipt_id, ack);
   expect(ack).toHaveBeenLastCalledWith(null);
 } finally { clock.mockRestore(); }
});
it('includes local command queue time and sends normally when queued beyond the receipt deadline', async () => {
 const lease = acquireRealtime(); releases.add(lease.release);
 const socket = clients[0]; lease.connect(); socket.receive('chat.receipts.enabled');
 const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
 let unblock!: (result: unknown) => void;
 const emit = vi.fn().mockImplementation((name: string) => name === 'updates.subscribe'
   ? new Promise(resolve => { unblock = resolve; }) : Promise.resolve({ data: {} }));
 socket.timeout = () => ({ emitWithAck: emit });
 async function waitInQueue(ms: number) {
   const subscription = socketCommand(socket, 'updates.subscribe', {});
   const message = socketCommand(socket, 'message.send', { text: 'queued' });
   await Promise.resolve(); clock.mockReturnValue(ms); unblock({ data: {} });
   await Promise.all([subscription, message]);
   return (emit.mock.lastCall as unknown as [string, { receipt_id?: string }])[1];
 }
 try {
   const sent = await waitInQueue(500);
   const ack = vi.fn(); clock.mockReturnValue(625);
   socket.receive('chat.receipt.confirmed', sent.receipt_id, ack);
   expect(ack).toHaveBeenCalledWith(525);
   expect(await waitInQueue(17000)).toEqual({ text: 'queued' });
 } finally { clock.mockRestore(); }
});
