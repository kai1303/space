import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Redis loss between server-count and publication rejects delivery without crashing Node', {timeout:10_000}, () => {
  const child = spawnSync(process.execPath,[fileURLToPath(new URL('./redis-adapter-outage.mjs',import.meta.url))],{
    env:process.env,encoding:'utf8',timeout:8000,
  });
  assert.equal(child.status,0,child.stderr || String(child.error));
  assert.match(child.stdout,/publication failure remains retryable/);
});
