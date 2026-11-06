import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePairing, parsePairingClaim } from '@space/contracts';
test('pairing selects a supported provider and preserves the Codex default', () => {
  assert.equal(parsePairing({}).provider, 'codex');
  assert.equal(parsePairing({ provider: 'kiro' }).provider, 'kiro');
  assert.equal(parsePairing({ provider: 'claude' }).provider, 'claude');
  assert.equal(parsePairingClaim({ code: 'a'.repeat(32), credential: 'b'.repeat(43), provider: 'claude' }).provider, 'claude');
  assert.throws(() => parsePairing({ provider: 'shell' }), /invalid_provider/);
  assert.equal(parsePairingClaim({ code: 'a'.repeat(32), credential: 'b'.repeat(43), provider: 'kiro' }).provider, 'kiro');
});

test('session capability is an optional boolean and pairing identity cannot carry capabilities', async () => {
 const {parseCapabilities}=await import('@space/contracts');
 assert.equal(parseCapabilities({skills:['research.run'],controls:{},persistent_sessions:true}).persistent_sessions,true);
 assert.equal(parseCapabilities({skills:['research.run'],controls:{},persistent_sessions:false}).persistent_sessions,false);
 assert.throws(()=>parseCapabilities({skills:['research.run'],controls:{},persistent_sessions:'yes'}),/invalid_persistent_sessions/);
 assert.equal(parsePairing({connector_id:'research.local'}).connector_id,'research.local');
 assert.throws(()=>parsePairing({connector_id:'research.local',capabilities:{skills:['shell'],controls:{}}}),/unknown_field/);
 assert.throws(()=>parsePairingClaim({code:'a'.repeat(32),credential:'b'.repeat(43),connector_id:'research.local'}),/unknown_field/);
});
