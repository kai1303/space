import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { RedisSocketAdapter } from '@space/redis';
const { Server } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('socket.io');
const key = `adapter_outage_${randomUUID()}`;
const left = new RedisSocketAdapter(process.env.TEST_REDIS_URL,key);
const right = new RedisSocketAdapter(process.env.TEST_REDIS_URL,key);
await Promise.all([left.connect(),right.connect()]);
const one = new Server(createServer(),{adapter:left.adapter}), two = new Server(createServer(),{adapter:right.adapter});
two.on('probe', ack => ack());
try {
  const adapter = one.of('/').adapter;
  const deadline = Date.now()+3000;
  while (await adapter.serverCount() !== 2) { assert.ok(Date.now()<deadline); await delay(20); }
  const count = adapter.serverCount.bind(adapter);
  adapter.serverCount = async () => {
    const result = await count();
    adapter.pubClient.destroy(); // Connection fails after readiness/count, before PUBLISH.
    return result;
  };
  await assert.rejects(one.serverSideEmitWithAck('probe'), /timeout/);
  await delay(20); // An unobserved command rejection terminates this child process.
  console.log('publication failure remains retryable');
} finally {
  await Promise.all([new Promise(resolve=>one.close(resolve)),new Promise(resolve=>two.close(resolve))]);
  await Promise.all([left.close(),right.close()]);
}
