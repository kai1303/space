import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
test('outbound secrets are encrypted with owner and connection binding', async () => {
  assert.ok(existsSync('../adapters/postgres/outbound-security.ts'), 'security implementation exists');
  const { OutboundSecurity } = await import('@space/postgres/outbound-security');
  const security = new OutboundSecurity(randomBytes(32).toString('hex'));
  const encrypted = security.encrypt('secret-token', 'owner:connection');
  assert.ok(!encrypted.includes('secret-token'));
  assert.equal(security.decrypt(encrypted, 'owner:connection'), 'secret-token');
  assert.throws(() => security.decrypt(encrypted, 'other:connection'));
  assert.throws(() => new OutboundSecurity('weak'));
  const token = security.sign({
    owner: 'u',
    installation: 'i',
    execution: 'e',
    aud: 'outbound',
    exp: Date.now() + 1000,
  });
  assert.equal(security.verify(token, 'outbound').owner, 'u');
  assert.throws(() => security.verify(token, 'internal'));
  assert.throws(() => security.verify(token.slice(0, -2) + 'xx', 'outbound'));
  assert.throws(() =>
    security.verify(
      security.sign({ owner: 'u', installation: 'i', execution: 'e', aud: 'outbound', exp: Date.now() - 1 }),
      'outbound',
    ),
  );
});

test('gateway tool aliases stay distinct and fit native provider name limits', async () => {
  const { outboundToolName } = await import('@space/postgres/outbound');
  const name = outboundToolName('connection-a', 'a'.repeat(64));
  assert.ok(`mcp__space_outbound__${name}`.length <= 64);
  assert.equal(name, outboundToolName('connection-a', 'a'.repeat(64)));
  assert.notEqual(name, outboundToolName('connection-b', 'a'.repeat(64)));
  assert.notEqual(name, outboundToolName('connection-a', 'a'.repeat(63) + 'b'));
  assert.match(outboundToolName('a', 'dotted.tool'), /^[a-zA-Z0-9_-]+$/);
});
