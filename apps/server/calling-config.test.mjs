import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {callIceConfig} from './dist/calling-config.js';
test('TURN credentials are temporary, user scoped, and do not expose the shared secret',()=>{
 const config=callIceConfig('actor',{CALL_TURN_URLS:'turn:relay.example:3478?transport=udp,turns:relay.example:443?transport=tcp',CALL_TURN_SECRET:'test-secret'},1000);
 assert.equal(config.hasTurn,true);assert.equal(config.iceServers[0].username,'4600:actor');
 assert.equal(config.iceServers[0].credential,createHmac('sha1','test-secret').update('4600:actor').digest('base64'));
 assert.ok(!JSON.stringify(config).includes('test-secret'));
});
test('invalid or incomplete TURN configuration fails explicitly',()=>{
 assert.throws(()=>callIceConfig('a',{CALL_TURN_URLS:'https://example.test',CALL_TURN_SECRET:'x'}));
 assert.throws(()=>callIceConfig('a',{CALL_TURN_URLS:'turn:example.test'}));
 assert.throws(()=>callIceConfig('a',{CALL_ICE_RELAY_ONLY:'true'}));
 assert.equal(callIceConfig('a',{}).hasTurn,false);
});
