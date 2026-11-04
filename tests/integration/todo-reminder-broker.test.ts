import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'nats';
import { EventBus, streamName } from '@space/events';

test('Todo schedules survive publisher shutdown and redeliver after an unacknowledged consumer stops', { timeout: 15000 }, async () => {
  const schema = `todo_broker_${randomBytes(8).toString('hex')}`;
  const url = process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
  const producer = new EventBus(url, schema), first = new EventBus(url, schema), recovered = new EventBus(url, schema);
  const id = randomUUID(), availableAt = new Date(Date.now() + 2000).toISOString();
  let timer: NodeJS.Timeout | undefined;
  const deadline = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Todo reminder delivery timed out')), 6000);
  })]).finally(() => clearTimeout(timer));
  try {
    await producer.start();
    await producer.publish({ id, schema, kind: 'todo.reminder_due', aggregate_id: id,
      data: { todo_id: id, remind_at: availableAt, reminder_version: 1 }, available_at: availableAt });
    await producer.close();
    await first.start();
    let delivered!: (received: string) => void;
    const pending = new Promise<string>(resolve => { delivered = resolve; });
    await first.subscribe('todo.reminder_due.*', { durable: 'todo-reminders', queue: 'todo-reminders', maxPending: 1 }, async message => {
      delivered(message.event.id);
    });
    assert.equal(await deadline(pending), id);
    assert.ok(Date.now() >= Date.parse(availableAt), 'broker must retain the future schedule until due');
    await first.close();
    await recovered.start();
    const redelivery = new Promise<string>(resolve => { delivered = resolve; });
    await recovered.subscribe('todo.reminder_due.*', { durable: 'todo-reminders', queue: 'todo-reminders', maxPending: 1 }, async message => {
      await message.ack(); delivered(message.event.id);
    });
    assert.equal(await deadline(redelivery), id);
  } finally {
    await producer.close(); await first.close(); await recovered.close();
    const connection = await connect({ servers: url });
    try {
      const manager = await connection.jetstreamManager();
      for (const suffix of ['CHAT', 'WORK']) await manager.streams.delete(`${streamName(schema)}_${suffix}`).catch(error => { if (error.code !== '404') throw error; });
    } finally { await connection.close(); }
  }
});
