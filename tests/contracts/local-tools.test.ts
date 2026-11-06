import test from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '@space/contracts';

test('local tool approvals validate identity, supported action and bounded display content', () => {
  const parse = (contracts as any).parseLocalToolApproval;
  assert.equal(typeof parse, 'function');
  const input = {id:'11111111-1111-4111-8111-111111111111',kind:'command',title:'Run tests',details:'pnpm test'};
  assert.deepEqual(parse(input),input);
  for (const change of [{id:'bad'},{kind:'shell_bypass'},{details:'x'.repeat(8001)},{title:'x'.repeat(201)},{details:'a\0b'},{path:'/unexpected'}]) {
    assert.throws(()=>parse({...input,...change}));
  }
});
