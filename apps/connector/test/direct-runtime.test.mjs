import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';import {Server} from 'socket.io';import {connectPlatform} from '../dist/runtime.js';
test('direct socket turns start independently, reject a busy session, deduplicate offers, and do not claim a queue for direct turns',{timeout:15000},async()=>{
 const http=createServer(),io=new Server(http);await new Promise(r=>http.listen(0,'127.0.0.1',r));
 const installation=randomUUID(),pending=new Map(),seen=[],aborted=[];let legacyClaims=0,peer;
 const initialClaim=new Promise(resolve=>io.of('/agents').on('connection',s=>{peer=s;
  s.on('agent.heartbeat',(_input,ack)=>{ack({data:{installation_id:installation}});});
  s.on('agent.task.claim',(_input,ack)=>{legacyClaims++;ack({data:null});resolve();});
  for(const name of ['event','renew','finish','fail'])s.on(`agent.turn.${name}`,(input,ack)=>{seen.push({name,...input});ack({data:true});});
 }));
 const platform=connectPlatform({origin:`http://127.0.0.1:${http.address().port}`,credential:'fixture',installation_id:installation,workspace_id:randomUUID(),provider:'codex'},()=> 'ready',()=>{},async(request,emit,signal)=>{
  let seq=0;const event=type=>({id:randomUUID(),schema_version:'1.0',execution_id:request.execution_id,sequence:++seq,type,occurred_at:new Date().toISOString(),payload:{text:'Hello'}});
  await emit(event('execution.started'));
  await new Promise((resolve,reject)=>{pending.set(request.session_id,resolve);signal.addEventListener('abort',()=>{aborted.push(request.session_id);reject(signal.reason??new Error('Aborted'));},{once:true});});
  await emit(event('execution.completed'));
 });
 try{
  await initialClaim;const initialClaims=legacyClaims;
  const request=()=>{const execution_id=randomUUID();return {schema_version:'1.0',task_id:randomUUID(),execution_id,idempotency_key:execution_id,session_id:randomUUID(),skill:'codex.run',goal:'hello'};};
  const a=request(),b=request();
  // The startup claim ACK and the first offer can arrive in the same socket turn.
  // Wait for the connector to report capacity before exercising direct dispatch.
  const capacityDeadline=Date.now()+2000;
  for (;;) {
    const reply=await peer.timeout(1000).emitWithAck('agent.turn.capacity',{session_id:a.session_id});
    if (reply.data===true) break;
    assert.equal(reply.error,'agent_capacity');
    assert.ok(Date.now()<capacityDeadline,'startup claim did not release capacity');
  }
  assert.equal((await peer.timeout(1000).emitWithAck('agent.turn.start',a)).data,true);
  assert.equal((await peer.timeout(1000).emitWithAck('agent.turn.start',b)).data,true);
  assert.equal((await peer.timeout(1000).emitWithAck('agent.turn.capacity',{session_id:a.session_id})).error,'agent_busy');
  assert.equal((await peer.timeout(1000).emitWithAck('agent.turn.start',a)).data,true);
  const deadline=Date.now()+2000;while(pending.size<2 && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(pending.size,2);assert.equal(legacyClaims,initialClaims);assert.equal(seen.filter(x=>x.name==='event').length,2);
  pending.get(a.session_id)();pending.get(b.session_id)();
  while(seen.filter(x=>x.name==='finish').length<2 && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(seen.filter(x=>x.name==='finish').length,2);
  const c=request(),d=request();await peer.timeout(1000).emitWithAck('agent.turn.start',c);await peer.timeout(1000).emitWithAck('agent.turn.start',d);
  while(pending.size<4 && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  peer.emit('agent.turn.stop',{session_id:c.session_id,execution_id:c.execution_id});
  while(!aborted.includes(c.session_id) && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.ok(aborted.includes(c.session_id));assert.equal(aborted.includes(d.session_id),false);
  pending.get(d.session_id)();while(seen.filter(x=>x.name==='finish').length<3 && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(seen.filter(x=>x.name==='finish').length,3);assert.equal(seen.filter(x=>x.name==='fail').length,0);

 }finally{platform.close();await io.close();await new Promise(r=>http.close(r));}
});
