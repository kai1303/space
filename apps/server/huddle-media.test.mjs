import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AccessToken} from 'livekit-server-sdk';
import {huddleMedia} from './dist/huddle-media.js';
const env={LIVEKIT_URL:'http://127.0.0.1:7880',LIVEKIT_PUBLIC_URL:'ws://127.0.0.1:7880',LIVEKIT_API_KEY:'test-key',LIVEKIT_API_SECRET:'test-huddle-secret-at-least-32-characters'};
test('signed webhook authenticates the exact bytes and rejects forged or modified bodies',async()=>{
 const media=huddleMedia(env),body=JSON.stringify({event:'room_finished',id:'EV_fixture',room:{name:'space-huddle-00000000-0000-4000-8000-000000000001'}});
 const token=new AccessToken(env.LIVEKIT_API_KEY,env.LIVEKIT_API_SECRET,{ttl:60});token.sha256=createHash('sha256').update(body).digest('base64');
 const signed=await token.toJwt();assert.equal((await media.webhook(body,signed)).event,'room_finished');
 await assert.rejects(media.webhook(body));await assert.rejects(media.webhook(`${body} `,signed));
});
test('disabled, incomplete, and insecure production configurations are explicit',()=>{
 assert.equal(huddleMedia({}),undefined);
 assert.throws(()=>huddleMedia({LIVEKIT_URL:env.LIVEKIT_URL}),/Complete LiveKit/);
 assert.throws(()=>huddleMedia({...env,NODE_ENV:'production'}),/TLS/);
});
