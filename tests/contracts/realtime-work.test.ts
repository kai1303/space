import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeWork, SubscriptionIndex} from '../../apps/server/dist/realtime-work.js';

test('database work bounds active/queued tasks, cancels disconnected owners and serves other owners',async()=>{
  const queue=new RealtimeWork(1,2);let release!:()=>void;const order:string[]=[];
  const first=queue.run('a',()=>new Promise<void>(resolve=>{release=resolve;}));
  const cancelled=queue.run('a',async()=>{order.push('cancelled');});
  const next=queue.run('b',async()=>{order.push('b');});
  await assert.rejects(queue.run('c',async()=>{}),/realtime_overloaded/);
  assert.deepEqual(queue.stats().active,1);assert.equal(queue.stats().queued,2);
  const cancellation=assert.rejects(cancelled,/connection_closed/);
  queue.cancel('a');await cancellation;
  release();await first;await next;
  assert.deepEqual(order,['b']);assert.equal(queue.stats().queued,0);
});

test('subscription index deduplicates matching keys and removes departed subscriptions',()=>{
  const index=new SubscriptionIndex();let a=0,b=0;
  const remove=index.add(['global','workspace:a','channel:a'],()=>a++);
  index.add(['global','workspace:b'],()=>b++);
  index.wake(['workspace:a','channel:a']);assert.equal(a,1);assert.equal(b,0);
  remove();index.wake();assert.equal(a,1);assert.equal(b,1);
});

test('queued database work rotates owners instead of draining one socket first',async()=>{
  const queue=new RealtimeWork(1,10);let release!:()=>void;const order:string[]=[];
  const running=queue.run('a',()=>new Promise<void>(resolve=>{release=resolve;}));
  await Promise.resolve();
  const queued=['a','a','a','b','b'].map(owner=>queue.run(owner,async()=>{order.push(owner);}));
  release();await running;await Promise.all(queued);
  assert.deepEqual(order,['a','b','a','b','a']);
});
