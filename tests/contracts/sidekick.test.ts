import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseSidekickInput, parseSidekickContext } from '@space/contracts';
const channel_id=randomUUID(),thread_id=randomUUID();
const input={client_session_id:randomUUID(),installation_id:randomUUID(),skill:'codex.run'};
test('handoff selectors reject ambiguity, injected content, invalid IDs and oversized selections',()=>{
 const first=randomUUID(),second=randomUUID();
 assert.deepEqual(parseSidekickInput({...input,source:{channel_id,message_ids:[second,first,first]}}).source,{channel_id,message_ids:[first,second].sort()});
 for(const source of [{channel_id},{channel_id,thread_id,message_ids:[first]},{channel_id,message_ids:[]},{channel_id,message_ids:['bad']},{channel_id,message_ids:[first],text:'Forged'},{channel_id,message_ids:Array.from({length:51},()=>randomUUID())}]) assert.throws(()=>parseSidekickInput({...input,source}));
});
test('snapshot bounds use UTF-8 bytes and preserve complete quoted text without truncating',()=>{
 const context={channel_id,channel_name:'team',captured_at:new Date().toISOString(),messages:[{id:randomUUID(),thread_id,author:'Kai',text:'Discuss this\nwith me',created_at:new Date().toISOString(),files:['notes.txt']}]};
 assert.deepEqual(parseSidekickContext(context),context);
 assert.throws(()=>parseSidekickContext({...context,messages:[{...context.messages[0],text:'界'.repeat(8000)}]}),{code:'sidekick_context_too_large'});
 assert.throws(()=>parseSidekickContext({...context,messages:[{...context.messages[0],created_at:'yesterday'}]}));
});
